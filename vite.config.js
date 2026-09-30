import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
// Preserve existing essay source verbatim, including its original legacy assets.
export default defineConfig({
  plugins:[{name:'preserve-existing-essays',closeBundle(){for(const file of ['essays','main.js','styles.css','cosmos.js'])cpSync(file,`dist/${file}`,{recursive:true});}}],
  build:{rollupOptions:{input:{main:resolve('index.html'),portfolio:resolve('portfolio.html')},output:{manualChunks:(id)=>id.includes('node_modules/three/')?'three':undefined}}},
  server:{host:'0.0.0.0',port:4173,strictPort:true}
});
