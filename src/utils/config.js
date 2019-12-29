import yaml from 'js-yaml';
import { evaluate } from '.';

// eslint-disable-next-line import/prefer-default-export
export function parseConfig(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    // not JSON format
  }

  try {
    return yaml.safeLoad(content);
  } catch (error) {
    // not YAML format
  }

  try {
    return evaluate(`module.exports = ${content}`);
  } catch (error) {
    // not valid JavaScript code
  }

  try {
    return evaluate(content);
  } catch (error) {
    // not valid JavaScript code
  }

  // parse fail, return nothing
  return null;
}
