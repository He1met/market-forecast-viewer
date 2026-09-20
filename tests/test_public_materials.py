import base64, importlib.util, io, json, os, tempfile, unittest, zipfile
from unittest.mock import patch
from pathlib import Path
s=importlib.util.spec_from_file_location('materials',Path(__file__).parents[1]/'scripts/export-project-materials.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Materials(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir()
 def export(self, **extra):
  spec={'sources':[{'name':'real-data','path':str(self.source)}],'captured_at':'2026-09-21T00:00:00Z','scope':'SYNTHETIC safety test',**extra};out=self.root/'out';result=m.Exporter(spec,out).scan();return result,out
 def test_full_model_and_token_counts_unchanged(self):
  original=b'{"analysis":"whole business reasoning","key":"ordinary","token_count":123,"max_tokens":500,"input_tokens":8,"probabilities":[0.2,0.8]}'
  self.assertEqual(m.sanitize_text(original),original)
 def test_nested_json_escaped_url_ansi_and_base64(self):
  credential='sk-proj-'+'S'*32
  value={'model_output':'Keep this complete reasoning.','nested':json.dumps({'api_key':credential,'max_tokens':120}), 'encoded':base64.b64encode(json.dumps({'refresh_token':credential}).encode()).decode(), 'log':'\x1b[31mAuthorization: Bearer '+credential+'\x1b[0m https://user:password@example.test/path /Users/private-user/project'}
  out=m.sanitize_text(json.dumps(value).encode());clean=json.loads(out)
  self.assertNotIn(credential,out.decode());self.assertNotIn('user:password',out.decode());self.assertNotIn('private-user',out.decode());self.assertNotIn(credential,base64.b64decode(clean['encoded']).decode());self.assertEqual(clean['model_output'],value['model_output']);self.assertEqual(json.loads(clean['nested'])['max_tokens'],120)
 def test_private_file_excluded_without_open(self):
  p=self.source/'owner.json';p.write_text('DO_NOT_READ_SECRET');p.chmod(0)
  original=m.os.open
  def guard(path,*args,**kwargs):
   if Path(path)==p:raise AssertionError('private content opened')
   return original(path,*args,**kwargs)
  with patch.object(m.os,'open',guard):result,out=self.export()
  self.assertEqual(result['excluded'],1);self.assertEqual(list((out/'objects').iterdir()),[])
 def test_prefixed_escaped_json_all_cookie_fields_and_dictionary_keys(self):
  private='SYNTHETIC_PRIVATE_VALUE'
  for escapes in range(1,5):
   payload={'api_key':private,'result':'complete business reasoning'}
   for _ in range(escapes):payload=json.dumps(payload)
   out=m.sanitize_text(('INFO payload='+payload).encode()).decode()
   self.assertNotIn(private,out);self.assertIn('complete business reasoning',out)
  out=m.sanitize_text(b'Cookie: session=SYNTHETIC_PRIVATE_VALUE; csrf=SECOND_SYNTHETIC_VALUE\nresult=complete')
  self.assertNotIn(b'SYNTHETIC_VALUE',out);self.assertNotIn(private.encode(),out);self.assertIn(b'result=complete',out)
  out=m.sanitize_text(json.dumps({'https://user:pass@example.test':'ordinary','result':'complete'}).encode())
  self.assertNotIn(b'user:pass',out);self.assertIn(b'ordinary',out)
 def test_sanitized_key_collision_blocks_instead_of_losing_business_content(self):
  with self.assertRaisesRegex(ValueError,'REDACTED_KEY_COLLISION'):m.sanitize_text(json.dumps({'https://a:b@example.test':1,'https://c:d@example.test':2}).encode())
 def test_literal_identifier_review_is_exact_and_does_not_skip_other_redaction(self):
  token='ConsumeAccountRateLimitResetCreditParams'
  with self.assertRaisesRegex(ValueError,'ENCODED_BINARY'):m.sanitize_text(token.encode())
  self.assertEqual(m.sanitize_text(token.encode(),{token}),token.encode())
  secret=token+' password=never-public';self.assertNotIn(b'never-public',m.sanitize_text(secret.encode(),{token}))
  with self.assertRaisesRegex(ValueError,'INVALID_LITERAL_REVIEW'):self.export(literal_token_reviews=[{'token':token,'decision':'literal_project_identifier','sha256':'0'*64,'reason':'synthetic wrong hash'}])
 def test_prefixed_encoded_credentials_and_unknown_encoded_binary(self):
  private='SYNTHETIC_PRIVATE_VALUE'
  payload=base64.b64encode(json.dumps({'password':private,'result':'full result'}).encode()).decode()
  out=m.sanitize_text(('INFO base64='+payload).encode()).decode().split('=',1)[1]
  decoded=base64.b64decode(out).decode();self.assertNotIn(private,decoded);self.assertIn('full result',decoded)
  opaque=base64.b64encode(bytes(range(64))).decode()
  with self.assertRaisesRegex(ValueError,'ENCODED_BINARY'):m.sanitize_text(('blob='+opaque).encode())
  original='sha256='+'abcdef0123456789'*4;self.assertEqual(m.sanitize_text(original.encode()),original.encode())
  path='artifacts/executor/receipts/'+('abcdef0123456789'*4)+'.json';self.assertEqual(m.sanitize_text(path.encode()),path.encode())
  for literal in ['attachments/'+'a'*40,'release/pause/status/index/cycle/forecast/evaluation','business/code/Git/queue/release/lock/pause/configuration/service']:
   self.assertEqual(m.sanitize_text(literal.encode()),literal.encode())
 def test_nested_archive_secret_and_private_filename(self):
  with zipfile.ZipFile(self.source/'trace.zip','w') as z:
   z.writestr('run.json','{"password":"never-public","result":"full result"}')
   z.writestr('nested/auth.json','PRIVATE_DO_NOT_OPEN')
  result,out=self.export();self.assertEqual(result['expanded'],1);self.assertEqual(result['excluded'],1)
  manifest=m.verify(out,result['manifest_sha256']);exported=b''.join(p.read_bytes() for p in (out/'objects').iterdir());self.assertNotIn(b'never-public',exported);self.assertNotIn(b'PRIVATE_DO_NOT_OPEN',exported);self.assertIn(b'full result',exported)
 def test_duplicate_content_retains_all_logical_files(self):
  (self.source/'a.txt').write_text('same');(self.source/'b.txt').write_text('same');result,out=self.export();self.assertEqual(result['included'],2);self.assertEqual(result['unique_objects'],1);self.assertEqual(len(m.verify(out,result['manifest_sha256'])['entries']),2)
 def test_wrong_hash_and_omission_rejected(self):
  (self.source/'a').write_text('data');result,out=self.export()
  with self.assertRaisesRegex(ValueError,'MANIFEST_HASH'):m.verify(out,'0'*64)
  obj=next((out/'objects').iterdir());obj.write_bytes(b'bad')
  with self.assertRaisesRegex(ValueError,'OBJECT_HASH'):m.verify(out,result['manifest_sha256'])
  obj.unlink()
  with self.assertRaises(FileNotFoundError):m.verify(out,result['manifest_sha256'])
 def test_unreferenced_object_rejected(self):
  result,out=self.export();(out/'objects'/('0'*64)).write_text('hidden')
  with self.assertRaisesRegex(ValueError,'UNREFERENCED'):m.verify(out,result['manifest_sha256'])
 def test_output_recursion_rejected(self):
  with self.assertRaisesRegex(ValueError,'OUTPUT_INSIDE_SOURCE'):m.Exporter({'sources':[{'name':'s','path':str(self.source)}]},self.source/'out')
 def test_source_symlink_blocks_publication(self):
  (self.root/'secret').write_text('private');(self.source/'link').symlink_to(self.root/'secret');result,out=self.export();self.assertEqual(result['blocked'],1)
  with self.assertRaisesRegex(ValueError,'UNRESOLVED'):m.verify(out,result['manifest_sha256'])
 def test_archive_traversal_rejected(self):
  with zipfile.ZipFile(self.source/'trace.zip','w') as z:z.writestr('../leak','no')
  with self.assertRaisesRegex(ValueError,'UNSAFE_LOGICAL_PATH'):self.export()
 def test_unknown_binary_blocks(self):
  (self.source/'looks-like-json.json').write_bytes(b'\x00\xffSECRET');result,out=self.export();self.assertEqual(result['blocked'],1);self.assertEqual(result['included'],0)
 def test_missing_source_rejected(self):
  self.source.rmdir()
  with self.assertRaisesRegex(ValueError,'SOURCE_MISSING'):self.export()
 def test_unknown_manifest_status_rejected(self):
  (self.source/'a').write_text('data');result,out=self.export();manifest=json.loads((out/'manifest.json').read_text());manifest['entries'][0]['status']='silently_omitted';raw=m.encode(manifest);(out/'manifest.json').write_bytes(raw)
  with self.assertRaisesRegex(ValueError,'ENTRY_STATUS'):m.verify(out,m.sha(raw))
 def test_jpeg_metadata_and_trailing_payload_rejected(self):
  # Minimal structural fixture, not a rendered image or real review.
  segment=lambda marker,payload:bytes([255,marker])+(len(payload)+2).to_bytes(2,'big')+payload
  base=b'\xff\xd8'+segment(0xc0,b'frame')+segment(0xda,b'scan')+b'\x01\xff\x00\x02\xff\xd9'
  m.jpeg_check(base)
  with self.assertRaisesRegex(ValueError,'JPEG_STRUCTURE'):m.jpeg_check(base+b'private')
  with self.assertRaisesRegex(ValueError,'JPEG_METADATA'):m.jpeg_check(base[:2]+segment(0xe1,b'Exif-private')+base[2:])
  with self.assertRaisesRegex(ValueError,'JPEG_TRUNCATED'):m.jpeg_check(base[:-1])
 def test_image_review_required_even_with_valid_container(self):
  import struct,zlib
  chunk=lambda tag,payload:struct.pack('>I',len(payload))+tag+payload+struct.pack('>I',zlib.crc32(tag+payload)&0xffffffff)
  data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\xff\xff\xff'))+chunk(b'IEND',b'')
  (self.source/'image.png').write_bytes(data);result,out=self.export();self.assertEqual(result['blocked'],1)
  with self.assertRaisesRegex(ValueError,'UNRESOLVED'):m.verify(out,result['manifest_sha256'])
 def test_bundle_only_verified_references_never_pending(self):
  (self.source/'a.txt').write_text('full model output');result,out=self.export();(out/'pending'/'private').write_text('never publish');dest=self.root/'volumes';receipt=m.bundle(out,result['manifest_sha256'],dest,4096)
  index=json.loads((dest/'volumes.json').read_text());names=[]
  for part in index['parts']:
   self.assertEqual(m.sha((dest/part['name']).read_bytes()),part['sha256'])
   with zipfile.ZipFile(dest/part['name']) as archive:names+=archive.namelist();self.assertNotIn(b'never publish',b''.join(archive.read(n) for n in archive.namelist()))
  self.assertEqual(set(names),{'manifest.json','objects/'+m.sha(b'full model output')})
  with self.assertRaisesRegex(ValueError,'OUTPUT_EXISTS'):m.bundle(out,result['manifest_sha256'],dest)
 def test_source_mutation_rejected(self):
  original=m.os.fstat;calls=0
  def changed(fd):
   nonlocal calls
   calls+=1
   if calls==2:(self.source/'a').write_text('changed')
   return original(fd)
  (self.source/'a').write_text('start');m.os.fstat=changed
  try:
   with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):self.export()
  finally:m.os.fstat=original
if __name__=='__main__':unittest.main()
