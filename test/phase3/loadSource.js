'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSource(filename, dependencies, globals = {}, suffix = '', main = false) {
  const resolved = path.resolve(__dirname, '../..', filename);
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Buffer, URL, Date,
    process: { env: {}, exit: jest.fn() },
    require(name) {
      if (!Object.hasOwn(dependencies, name)) {
        throw new Error(`Unmocked dependency forbidden: ${name}`);
      }
      return dependencies[name];
    },
    __dirname: path.dirname(resolved),
    ...globals,
  };
  context.require.main = main ? module : undefined;
  const names = Object.keys(context);
  const execute = vm.compileFunction(fs.readFileSync(resolved, 'utf8') + suffix, names, { filename: resolved });
  execute(...names.map(name => context[name]));
  return { exports: module.exports, context };
}

module.exports = { loadSource };
