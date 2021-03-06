/* eslint-disable mocha/no-setup-in-describe */
const fs = require('fs');
const path = require('path');
const get = require('lodash.get');
const yaml = require('js-yaml');
const expect = require('chai').expect;
const Joi = require('joi-strict');
const globSync = require('glob').sync;
const appRoot = require('app-root-path');
const sfs = require('smart-fs');
const {
  EnvManager,
  TimeKeeper,
  LogRecorder,
  RandomSeeder
} = require('node-tdd');
const ExpectService = require('./modules/expect-service');
const HandlerExecutor = require('./modules/handler-executor');
const ensureString = require('./util/ensure-string');
const rewriteObject = require('./util/rewrite-object');
const dynamicApply = require('./util/dynamic-apply');

module.exports = (options) => {
  Joi.assert(options, Joi.object().keys({
    cwd: Joi.string().optional(),
    name: Joi.string().optional(),
    verbose: Joi.boolean().optional(),
    timeout: Joi.number().min(0).integer().optional(),
    nockHeal: Joi.alternatives(Joi.boolean(), Joi.string()).optional(),
    enabled: Joi.boolean().optional(),
    handlerFile: Joi.string().optional(),
    cassetteFolder: Joi.string().optional(),
    envVarYml: Joi.string().optional(),
    envVarYmlRecording: Joi.string().optional(),
    testFolder: Joi.string().optional(),
    flush: Joi.array().items(Joi.string()).optional(),
    modifiers: Joi.object().optional(),
    stripHeaders: Joi.boolean().optional()
  }));

  const cwd = get(options, 'cwd', process.cwd());
  const name = get(options, 'name', 'lambda-test');
  const verbose = get(options, 'verbose', false);
  const timeout = get(options, 'timeout');
  const nockHeal = get(options, 'nockHeal', false);
  const enabled = get(options, 'enabled', true);
  const handlerFile = get(options, 'handlerFile', path.join(cwd, 'handler.js'));
  const cassetteFolder = get(options, 'cassetteFolder', path.join(cwd, '__cassettes'));
  const envVarYml = get(options, 'envVarYml', path.join(cwd, 'env.yml'));
  const envVarYmlRecording = get(options, 'envVarYmlRecording', path.join(cwd, 'env.recording.yml'));
  const testFolder = get(options, 'testFolder', cwd);
  const flush = get(options, 'flush', ['aws-sdk']);
  const modifiers = get(options, 'modifiers', {});
  const stripHeaders = get(options, 'stripHeaders', false);

  if (fs.existsSync(cassetteFolder)) {
    const invalidCassettes = sfs.walkDir(cassetteFolder)
      .filter((e) => !fs.existsSync(path.join(testFolder, e.substring(0, e.length - 15))));
    if (invalidCassettes.length !== 0) {
      throw new Error(`Rogue Cassette(s): ${invalidCassettes.join(', ')}`);
    }
  }

  sfs.walkDir(testFolder)
    .map((f) => path.join(testFolder, f))
    .filter((f) => {
      const relative = path.relative(cassetteFolder, f);
      return !relative || relative.startsWith('..') || path.isAbsolute(relative);
    })
    .forEach((filePath) => {
      if (!filePath.endsWith('.spec.json')) {
        throw new Error(`Unexpected File: ${filePath}`);
      }
    });

  let timeKeeper = null;
  let randomSeeder = null;
  const suiteEnvVarsWrapper = EnvManager({
    envVars: {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'XXXXXXXXXXXXXXXXXXXX',
      AWS_SECRET_ACCESS_KEY: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      ...yaml.safeLoad(fs.readFileSync(envVarYml, 'utf8'))
    },
    allowOverwrite: false
  });
  const suiteEnvVarsWrapperRecording = fs.existsSync(envVarYmlRecording) ? EnvManager({
    envVars: yaml.safeLoad(fs.readFileSync(envVarYmlRecording, 'utf8')),
    allowOverwrite: true
  }) : null;
  const expectService = ExpectService();
  return {
    execute: (modifier = '') => {
      if (enabled !== true) {
        return [];
      }

      const isPattern = typeof modifier === 'string' || modifier instanceof String;
      const testFiles = isPattern ? globSync('**/*.spec.json', {
        cwd: testFolder,
        nodir: true,
        ignore: ['**/*.spec.json_recording.json']
      }).filter((e) => new RegExp(modifier, '').test(e)) : modifier;

      describe(`Testing Lambda Functions: ${name}`, () => {
        before(() => suiteEnvVarsWrapper.apply());
        after(() => suiteEnvVarsWrapper.unapply());

        testFiles.forEach((testFile) => {
          // eslint-disable-next-line func-names
          it(`Test ${testFile}`, async function () {
            const test = JSON.parse(fs.readFileSync(path.join(testFolder, testFile), 'utf8'));
            const cassetteFile = `${testFile}_recording.json`;
            const isNewRecording = !fs.existsSync(path.join(cassetteFolder, cassetteFile));
            if (suiteEnvVarsWrapperRecording !== null && isNewRecording) {
              suiteEnvVarsWrapperRecording.apply();
            }
            const testEnvVarsWrapper = EnvManager({ envVars: test.env || {}, allowOverwrite: true });
            testEnvVarsWrapper.apply();
            if (test.timestamp !== undefined) {
              timeKeeper = TimeKeeper({ unix: test.timestamp });
              timeKeeper.inject();
            }
            if (test.seed !== undefined) {
              randomSeeder = RandomSeeder({ seed: test.seed, reseed: test.reseed || false });
              randomSeeder.inject();
            }
            if (timeout !== undefined) {
              this.timeout(timeout);
            } else if (test.timeout !== undefined) {
              this.timeout(test.timeout);
            }
            const logRecorder = LogRecorder({ verbose, logger: console });
            logRecorder.inject();

            // re-init function code here to ensures env vars are accessible outside lambda handler
            const nodeModulesDir = path.resolve(path.join(appRoot.path, 'node_modules')) + path.sep;
            const flushPaths = flush.map((e) => `${path.sep}node_modules${path.sep}${e}${path.sep}`);
            const nodeModulesPrefixLength = nodeModulesDir.length - 'node_modules'.length - 2;
            Object.keys(require.cache).forEach((key) => {
              if (!key.startsWith(nodeModulesDir)
                || flushPaths.some((f) => key.indexOf(f) >= nodeModulesPrefixLength)) {
                delete require.cache[key];
              }
            });

            try {
              const output = await HandlerExecutor({
                handlerFile,
                cassetteFolder,
                verbose,
                nockHeal,
                handlerFunction: test.handler,
                event: rewriteObject(test.event, modifiers),
                context: test.context || {},
                cassetteFile,
                lambdaTimeout: test.lambdaTimeout,
                stripHeaders: get(test, 'stripHeaders', stripHeaders)
              }).execute();
              const logs = {
                logs: logRecorder.levels()
                  .reduce((p, level) => Object.assign(p, { [level]: logRecorder.get(level) }), logRecorder.get())
              };

              // evaluate test configuration
              expect(JSON.stringify(Object.keys(test).filter((e) => [
                'expect',
                'handler',
                'success',
                'lambdaTimeout',
                'response',
                'timeout',
                'event',
                'context',
                'env',
                'logs',
                'error',
                'nock',
                'timestamp',
                'seed',
                'reseed',
                'body',
                'defaultLogs',
                'errorLogs',
                'stripHeaders',
                'allowedUnmatchedRecordings',
                'allowedOutOfOrderRecordings'
              ].indexOf(e) === -1 && !e.match(/^(?:expect|logs|errorLogs|defaultLogs)\(.+\)$/g)))).to.equal('[]');

              // test output
              if (test.success) {
                expect(output.err, `Error: ${get(output.err, 'stack', output.err)}`).to.equal(null);
              } else {
                expect(output.err, `Response: ${ensureString(output.response)}`).to.not.equal(null);
              }
              Object
                .keys(test)
                .filter((k) => k.match(/^(?:expect|logs|errorLogs|defaultLogs)(?:\(.*?\)$)?/))
                .forEach((k) => {
                  let target = null;
                  if (k.startsWith('expect')) {
                    target = test.success ? output.response : output.err;
                  } else {
                    target = logs[k.split('(')[0]];
                  }
                  if (k.indexOf('(') !== -1) {
                    const apply = k.split('(', 2)[1].slice(0, -1).split('|');
                    target = get(target, apply[0]);
                    if (apply.length > 1) {
                      target = apply.slice(1).reduce((p, c) => dynamicApply(c, p, modifiers), target);
                    }
                  }
                  expectService.evaluate(test[k], target);
                });

              if (test.error !== undefined || test.response !== undefined || test.body !== undefined) {
                // eslint-disable-next-line no-console
                console.warn('Warning: "error", "response" and "body" are deprecated. Use "expect" instead!');
              }
              expectService.evaluate(test.error, ensureString(output.err));
              expectService.evaluate(test.response, ensureString(output.response));
              expectService.evaluate(test.body, get(output.response, 'body'));
              expectService.evaluate(test.nock, ensureString(output.records));
              expect(
                output.unmatchedRecordings.every((r) => get(test, 'allowedUnmatchedRecordings', []).includes(r)),
                `Unmatched Recording(s): ${JSON.stringify(output.unmatchedRecordings)}`
              ).to.equal(true);
              expect(
                output.outOfOrderErrors.every((r) => get(test, 'allowedOutOfOrderRecordings', []).includes(r)),
                `Out of Order Recording(s): ${JSON.stringify(output.outOfOrderErrors)}`
              ).to.equal(true);
              return Promise.resolve();
            } finally {
              // "close" test run
              logRecorder.release();
              if (randomSeeder !== null) {
                randomSeeder.release();
                randomSeeder = null;
              }
              if (timeKeeper !== null) {
                timeKeeper.release();
                timeKeeper = null;
              }
              testEnvVarsWrapper.unapply();
              if (suiteEnvVarsWrapperRecording !== null && isNewRecording) {
                suiteEnvVarsWrapperRecording.unapply();
              }
            }
          });
        });
      });
      return testFiles;
    }
  };
};
