import config, { reactConfig } from '@iobroker/eslint-config';

export default [
    ...config,
    ...reactConfig,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        ignores: ['build/**/*', 'node_modules/**/*'],
    },
    {
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            'react/react-in-jsx-scope': 'off',
        },
    },
];
