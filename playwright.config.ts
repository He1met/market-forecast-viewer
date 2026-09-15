// @ts-expect-error Node evidence guard is integration-tested.
import {requireEvidence} from './scripts/evidence-context.mjs';
const evidence=requireEvidence();
const port=Number(process.env.MFV_E2E_PORT??5187);
import{defineConfig}from'@playwright/test';
export default defineConfig({outputDir:evidence.evidence_root+'/playwright-tmp',testDir:'tests/e2e',timeout:30000,fullyParallel:false,workers:1,reporter:[['list'],['json',{outputFile:evidence.evidence_root+'/e2e-results.json'}]],use:{baseURL:`http://127.0.0.1:${port}`,timezoneId:'Asia/Shanghai',trace:'retain-on-failure'},projects:[{name:'1440-dpr2',use:{viewport:{width:1440,height:900},deviceScaleFactor:2}},{name:'1280-dpr1',use:{viewport:{width:1280,height:800},deviceScaleFactor:1}},{name:'1440-dpr1',use:{viewport:{width:1440,height:900},deviceScaleFactor:1}},{name:'1280-dpr2',use:{viewport:{width:1280,height:800},deviceScaleFactor:2}}],webServer:{command:`node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,url:`http://127.0.0.1:${port}`,reuseExistingServer:false,timeout:20000}});
