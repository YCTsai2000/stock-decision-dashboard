import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑讓同一份 build 可部署到 username.github.io/任意-repo-name/
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
