import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.wrangler/**', '.vinext/**', '.next/**', 'node_modules/**', 'worker-configuration.d.ts', 'next-env.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    ignores: ['**/route.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'swell-node', message: 'Backend credentials belong in app Worker endpoints.' }],
        patterns: [{ group: ['**/swell-server', '**/swell-server.ts'], message: 'Keep server credentials out of browser code.' }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[object.object.type="MetaProperty"][object.property.name="env"][property.name=/^VITE_SWELL_/]',
        message: 'Use request-time Swell context, not build-time store values.',
      }],
    },
  },
);
