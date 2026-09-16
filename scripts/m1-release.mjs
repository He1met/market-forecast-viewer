// Candidate construction only. Activation requires separate exact-release approval.
import {releaseArguments} from './m1-admin-args.mjs';
import {buildPackage} from './m1-package-build.mjs';
import {requireEvidence} from './evidence-context.mjs';
try {
 const options=releaseArguments(process.argv.slice(2));
 // Verification checkouts must never emit a production-eligible package.
 const synthetic=!!process.env.MFV_EVIDENCE_CONTEXT;
 if(synthetic)requireEvidence();
 const manifest=await buildPackage({...options,synthetic});
 console.log(JSON.stringify({status:'candidate_verified',release_id:manifest.release_id,build_sha:manifest.build_sha,destination:options.destination,synthetic:manifest.synthetic,activated:false,maintainer_approval:false}));
} catch(error){console.error(error.message);process.exitCode=1;}
