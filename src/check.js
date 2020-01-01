import path from 'path';
import debugLib from 'debug';
import lodash from 'lodash';
import walkdir from 'walkdir';
import minimatch from 'minimatch';
import builtInModules from 'builtin-modules';
import requirePackageName from 'require-package-name';
import { loadModuleData, readJSON } from './utils';
import getNodes from './utils/parser';
import { getAtTypesName } from './utils/typescript';
import { getContentPromise } from './utils/file';
import { availableParsers } from './constants';

const debug = debugLib('depcheck');

function isModule(dir) {
  try {
    readJSON(path.resolve(dir, 'package.json'));
    return true;
  } catch (error) {
    return false;
  }
}

function mergeBuckets(object1, object2) {
  return lodash.mergeWith(object1, object2, (value1, value2) => {
    const array1 = value1 || [];
    const array2 = value2 || [];
    return array1.concat(array2);
  });
}

function detect(detectors, node, deps) {
  return lodash(detectors)
    .map((detector) => {
      try {
        return detector(node, deps);
      } catch (error) {
        return [];
      }
    })
    .flatten()
    .value();
}

function discoverPropertyDep(rootDir, deps, property, depName) {
  const { metadata } = loadModuleData(depName, rootDir);
  if (!metadata) return [];
  const propertyDeps = Object.keys(metadata[property] || {});
  return lodash.intersection(deps, propertyDeps);
}

async function getDependencies(dir, filename, deps, parser, detectors) {
  debug('getDependencies', filename, parser);

  const content = await getContentPromise(filename);

  const ast = parser(content, filename, deps, dir);

  // when parser returns string array, skip detector step and treat them as dependencies.
  const dependencies =
    lodash.isArray(ast) && ast.every(lodash.isString)
      ? ast
      : lodash(getNodes(ast, filename))
          .map((node) => detect(detectors, node, deps))
          .flatten()
          .uniq()
          .map(requirePackageName)
          .thru((_dependencies) =>
            parser === availableParsers.typescript
              ? // If this is a typescript file, importing foo would also use @types/foo, but
                // only if @types/foo is already a specified dependency.
                lodash(_dependencies)
                  .map((dependency) => {
                    const atTypesName = getAtTypesName(dependency);
                    return deps.includes(atTypesName)
                      ? [dependency, atTypesName]
                      : [dependency];
                  })
                  .flatten()
                  .value()
              : _dependencies,
          )
          .value();

  const discover = lodash.partial(discoverPropertyDep, dir, deps);
  const discoverPeerDeps = lodash.partial(discover, 'peerDependencies');
  const discoverOptionalDeps = lodash.partial(discover, 'optionalDependencies');
  const peerDeps = lodash(dependencies)
    .map(discoverPeerDeps)
    .flatten()
    .value();
  const optionalDeps = lodash(dependencies)
    .map(discoverOptionalDeps)
    .flatten()
    .value();

  return dependencies.concat(peerDeps).concat(optionalDeps);
}

// const bench = {};

function checkFile(dir, filename, deps, parsers, detectors) {
  debug('checkFile', filename);

  // const start = process.hrtime.bigint();

  const basename = path.basename(filename);
  const targets = lodash(parsers)
    .keys()
    .filter((glob) => minimatch(basename, glob, { dot: true }))
    .map((key) => parsers[key])
    .flatten()
    .value();

  const result = targets.map((parser) =>
    getDependencies(dir, filename, deps, parser, detectors).then(
      (using) => ({
        using: {
          [filename]: lodash(using)
            .filter((dep) => dep && dep !== '.' && dep !== '..') // TODO why need check?
            .filter((dep) => !lodash.includes(builtInModules, dep))
            .uniq()
            .value(),
        },
      }),
      (error) => ({
        invalidFiles: {
          [filename]: error,
        },
      }),
    ),
  );

  // const end = process.hrtime.bigint();

  // const bench = Number(end - start) / 1000;

  // if (filename === '/Users/fhodierne/Dev/depcheck/doc/pluggable-design.md') {
  //   console.log(`${filename} took ${Number(end - start) / 1000} microseconds`);
  // }
  // if (bench > 2500) {
  //   console.log(`${filename} took ${Number(end - start) / 1000} nanoseconds`);
  // }

  // bench[filename] = end - start;

  // console.log(filename, end);

  debug('checkFile ended', filename);

  return result;
}

function checkDirectory(dir, rootDir, ignoreDirs, deps, parsers, detectors) {
  debug('dir', dir);

  const start = process.hrtime.bigint();

  return new Promise((resolve) => {
    const promises = [];
    const finder = walkdir(dir, { no_recurse: true, follow_symlinks: true });

    finder.on('directory', (subdir) => {
      // console.log('checkDirectory', dir);
      // console.log(ignoreDirs);
      // console.log(path.basename(subdir));
      // console.log(ignoreDirs.indexOf(path.basename(subdir)));
      return ignoreDirs.indexOf(path.basename(subdir)) === -1 &&
        !isModule(subdir)
        ? promises.push(
            checkDirectory(
              subdir,
              rootDir,
              ignoreDirs,
              deps,
              parsers,
              detectors,
            ),
          )
        : null;
    });

    finder.on('file', (filename) => {
      if (dir === '/Users/fhodierne/Dev/depcheck/doc') {
        debug('finder', filename);
      }
      promises.push(...checkFile(rootDir, filename, deps, parsers, detectors));
    });

    finder.on('error', (_, error) =>
      promises.push(
        Promise.resolve({
          invalidDirs: {
            [error.path]: error,
          },
        }),
      ),
    );

    finder.on('end', () => {
      const end = process.hrtime.bigint();

      // if (bench > 2500) {
      debug(
        `${dir} dir end took ${Number(end - start) / 1000 / 1000} milliseconds`,
      );

      resolve(
        Promise.all(promises).then((results) => {
          const endresolve = process.hrtime.bigint();

          // if (bench > 2500) {
          debug(
            `${dir} dir resolve took ${Number(endresolve - start) /
              1000 /
              1000} milliseconds`,
          );
          // }

          return results.reduce(
            (obj, current) => ({
              using: mergeBuckets(obj.using, current.using || {}),
              invalidFiles: Object.assign(
                obj.invalidFiles,
                current.invalidFiles,
              ),
              invalidDirs: Object.assign(obj.invalidDirs, current.invalidDirs),
            }),
            {
              using: {},
              invalidFiles: {},
              invalidDirs: {},
            },
          );
        }),
      );
    });
  });
}

function buildResult(
  result,
  deps,
  devDeps,
  peerDeps,
  optionalDeps,
  skipMissing,
) {
  const usingDepsLookup = lodash(result.using)
    // { f1:[d1,d2,d3], f2:[d2,d3,d4] }
    .toPairs()
    // [ [f1,[d1,d2,d3]], [f2,[d2,d3,d4]] ]
    .map(([file, dep]) => [dep, lodash.times(dep.length, () => file)])
    // [ [ [d1,d2,d3],[f1,f1,f1] ], [ [d2,d3,d4],[f2,f2,f2] ] ]
    .map((pairs) => lodash.zip(...pairs))
    // [ [ [d1,f1],[d2,f1],[d3,f1] ], [ [d2,f2],[d3,f2],[d4,f2]] ]
    .flatten()
    // [ [d1,f1], [d2,f1], [d3,f1], [d2,f2], [d3,f2], [d4,f2] ]
    .groupBy(([dep]) => dep)
    // { d1:[ [d1,f1] ], d2:[ [d2,f1],[d2,f2] ], d3:[ [d3,f1],[d3,f2] ], d4:[ [d4,f2] ] }
    .mapValues((pairs) => pairs.map(lodash.last))
    // { d1:[ f1 ], d2:[ f1,f2 ], d3:[ f1,f2 ], d4:[ f2 ] }
    .value();

  const usingDeps = Object.keys(usingDepsLookup);

  const missingDepsLookup = skipMissing
    ? []
    : (() => {
        const allDeps = deps
          .concat(devDeps)
          .concat(peerDeps)
          .concat(optionalDeps);

        const missingDeps = lodash.difference(usingDeps, allDeps);
        return lodash(missingDeps)
          .map((missingDep) => [missingDep, usingDepsLookup[missingDep]])
          .fromPairs()
          .value();
      })();

  return {
    dependencies: lodash.difference(deps, usingDeps),
    devDependencies: lodash.difference(devDeps, usingDeps),
    missing: missingDepsLookup,
    using: usingDepsLookup,
    invalidFiles: result.invalidFiles,
    invalidDirs: result.invalidDirs,
  };
}

export default function check({
  rootDir,
  ignoreDirs,
  skipMissing,
  deps,
  devDeps,
  peerDeps,
  optionalDeps,
  parsers,
  detectors,
}) {
  const allDeps = lodash.union(deps, devDeps);
  return checkDirectory(
    rootDir,
    rootDir,
    ignoreDirs,
    allDeps,
    parsers,
    detectors,
  ).then((result) =>
    buildResult(result, deps, devDeps, peerDeps, optionalDeps, skipMissing),
  );
}
