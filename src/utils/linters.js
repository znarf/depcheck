import * as path from 'path';
import * as fs from 'fs';
import getScripts from './get-scripts';
import { parseConfig } from './config';

export function getCustomConfig(kind, filename, content, rootDir) {
  const scripts = getScripts(filename, content);

  if (scripts.length === 0) {
    return null;
  }

  const script = scripts.find((s) => s.split(/\s+/).includes(kind));

  if (script) {
    const commands = script.split('&&');
    const command = commands.find((c) => c.startsWith(kind));

    if (command) {
      const args = command.split(/\s+/);
      const configIdx = args.findIndex((arg) =>
        ['--config', '-c'].includes(arg),
      );

      if (configIdx !== -1 && args[configIdx + 1]) {
        const configFile = args[configIdx + 1];
        const configPath = path.resolve(rootDir, configFile);

        const configContent = fs.readFileSync(configPath);
        return parseConfig(configContent);
      }
    }
  }

  return null;
}

export function loadConfig(flavour, filenameRegex, filename, content, rootDir) {
  const basename = path.basename(filename);

  if (filenameRegex.test(basename)) {
    const config = parseConfig(content);
    return config;
  }

  const custom = getCustomConfig(flavour, filename, content, rootDir);

  if (custom) {
    return custom;
  }

  return null;
}
