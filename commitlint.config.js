/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow the package/scope names we use in this monorepo.
    'scope-enum': [
      0,
      'always',
      ['agent', 'harness', 'example', 'ci', 'deps', 'docs', 'release'],
    ],
  },
};
