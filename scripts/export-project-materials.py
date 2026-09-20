#!/usr/bin/env python3
"""Prepare immutable, reviewable public copies. Never uploads or alters sources."""
import argparse, base64, hashlib, io, json, os, re, stat, tarfile, zipfile
from pathlib import Path, PurePosixPath

SCHEMA = 'MFV:PUBLIC_MATERIALS:v1'
MAX_FILE = 256 * 1024 * 1024
MAX_ARCHIVE = 1024 * 1024 * 1024
SENSITIVE_KEY = re.compile(r'^(?:.*(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)|token|authorization|cookie|installation_id|device_id|account_id|email)$', re.I)
SECRET = re.compile(r'(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)', re.I)
KEY_TEXT = re.compile(r'((?:["\']?)(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|token)(?:["\']?)\s*[:=]\s*)(["\'][^"\'\n]*["\']|[^\s,;}]+)', re.I)
PRIVATE_PATH = re.compile(r'/Users/[^/\s"\']+|/home/[^/\s"\']+|/private/var/folders/[^\s"\']+|/var/folders/[^\s"\']+')
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
URL_AUTH = re.compile(r'(?<=://)[^/\s@]+@')
EMAIL = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')
HEADER = re.compile(r'(?im)(\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:\s*)[^\r\n]+')
DENIED = re.compile(r'(?:^|/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.[^/]*)?|owner\.json|writer\.lock|installation\.local\.json|configuration\.json|config-(?:before|after|active-before|paused|proposal)\.json|installation-proposal\.json|installation-changes|runtime-snapshot/changes|m1-control|\.git)(?:/|$)', re.I)


def sha(data): return hashlib.sha256(data).hexdigest()
def encode(value): return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
def safe_name(name):
    p = PurePosixPath(name)
    if not name or '\\' in name or p.is_absolute() or '..' in p.parts or '\x00' in name:
        raise ValueError('UNSAFE_LOGICAL_PATH')
    return str(p)


def text_redact(value, depth=0):
    if depth > 20: raise ValueError('NESTING_LIMIT')
    if isinstance(value, dict):
        result = {}
        for k, v in value.items():
            clean_key = text_redact(k, depth + 1)
            if clean_key in result: raise ValueError('REDACTED_KEY_COLLISION')
            result[clean_key] = '[REDACTED]' if SENSITIVE_KEY.fullmatch(k) else text_redact(v, depth + 1)
        return result
    if isinstance(value, list): return [text_redact(v, depth + 1) for v in value]
    if not isinstance(value, str): return value
    # Structured JSON embedded in logs remains structured during sanitization.
    if value.lstrip().startswith(('{', '[')):
        try: nested = json.loads(value)
        except ValueError: pass
        else:
            cleaned = text_redact(nested, depth + 1)
            if cleaned != nested: return json.dumps(cleaned, ensure_ascii=False)
    # Installation journals can embed JSON as base64. Sanitize that content too.
    if len(value) >= 40 and len(value) % 4 == 0 and re.fullmatch(r'[A-Za-z0-9+/]*={0,2}', value):
        try:
            inner = base64.b64decode(value, validate=True).decode('utf-8')
            obj = json.loads(inner)
        except (ValueError, UnicodeError): pass
        else:
            cleaned = text_redact(obj, depth + 1)
            if cleaned != obj: return base64.b64encode(encode(cleaned)).decode()
    # Logs can prefix JSON, JSON strings, or multiply escaped JSON strings.
    # Decode complete embedded values rather than trying to regex escaped quotes.
    decoder = json.JSONDecoder(); pieces = []; cursor = 0; at = 0
    while at < len(value):
        if value[at] not in '{["': at += 1; continue
        try: nested, length = decoder.raw_decode(value[at:])
        except ValueError: at += 1; continue
        cleaned = text_redact(nested, depth + 1)
        if cleaned != nested:
            pieces.extend((value[cursor:at], json.dumps(cleaned, ensure_ascii=False)))
            cursor = at + length
        at += length
    if pieces: value = ''.join(pieces) + value[cursor:]
    value = ANSI.sub('', value)
    value = HEADER.sub(lambda m: m[1] + '[REDACTED]', value)
    value = URL_AUTH.sub('[REDACTED]@', value)
    value = SECRET.sub('[REDACTED]', value)
    value = KEY_TEXT.sub(lambda m: m[1] + '"[REDACTED]"', value)
    value = PRIVATE_PATH.sub('<LOCAL_PATH>', value)
    return EMAIL.sub('<REDACTED_EMAIL>', value)


def sanitize_text(data):
    text = data.decode('utf-8')
    if '\x00' in text: raise ValueError('BINARY_CONTENT')
    try: obj = json.loads(text)
    except ValueError:
        # Parse each JSONL record so nested values receive the same treatment.
        lines = text.splitlines(keepends=True)
        out = []
        for line in lines:
            try: obj = json.loads(line)
            except ValueError: out.append(text_redact(line))
            else:
                cleaned = text_redact(obj)
                out.append(line if cleaned == obj else json.dumps(cleaned, ensure_ascii=False) + ('\n' if line.endswith('\n') else ''))
        return ''.join(out).encode()
    cleaned = text_redact(obj)
    return data if cleaned == obj else encode(cleaned)


def png_check(data):
    if not data.startswith(b'\x89PNG\r\n\x1a\n'): raise ValueError('PNG_SIGNATURE')
    import struct, zlib
    offset = 8; seen = []
    while offset < len(data):
        if offset + 12 > len(data): raise ValueError('PNG_TRUNCATED')
        n = struct.unpack('>I', data[offset:offset+4])[0]; kind = data[offset+4:offset+8]
        end = offset + n + 12
        if end > len(data): raise ValueError('PNG_TRUNCATED')
        payload = data[offset+8:offset+8+n]
        crc = struct.unpack('>I', data[offset+8+n:end])[0]
        if zlib.crc32(kind+payload) & 0xffffffff != crc: raise ValueError('PNG_CRC')
        if kind not in [b'IHDR', b'IDAT', b'IEND', b'PLTE', b'tRNS', b'sRGB', b'gAMA', b'cHRM', b'pHYs', b'bKGD']:
            raise ValueError('PNG_METADATA_REQUIRES_REVIEW')
        seen.append(kind); offset = end
        if kind == b'IEND': break
    if not seen or seen[0] != b'IHDR' or seen[-1] != b'IEND' or offset != len(data): raise ValueError('PNG_STRUCTURE')


def jpeg_check(data):
    """Accept baseline screenshot JPEGs with only an empty JFIF header.

    EXIF, comments, other application blocks and trailing payloads require review.
    This checks containers, not the privacy of the visible pixels.
    """
    if not data.startswith(b'\xff\xd8'): raise ValueError('JPEG_SIGNATURE')
    offset = 2; seen_frame = False; seen_scan = False
    while offset < len(data):
        if data[offset] != 255: raise ValueError('JPEG_STRUCTURE')
        while offset < len(data) and data[offset] == 255: offset += 1
        if offset >= len(data): raise ValueError('JPEG_TRUNCATED')
        marker = data[offset]; offset += 1
        if marker == 0xd9:
            if offset != len(data) or not seen_frame or not seen_scan: raise ValueError('JPEG_STRUCTURE')
            return
        if offset + 2 > len(data): raise ValueError('JPEG_TRUNCATED')
        size = int.from_bytes(data[offset:offset+2], 'big')
        if size < 2 or offset + size > len(data): raise ValueError('JPEG_TRUNCATED')
        payload = data[offset+2:offset+size]; offset += size
        if marker == 0xe0:
            if len(payload) != 14 or payload[:5] != b'JFIF\x00' or payload[-2:] != b'\x00\x00': raise ValueError('JPEG_METADATA_REQUIRES_REVIEW')
        elif marker == 0xc0: seen_frame = True
        elif marker in (0xc4, 0xdb, 0xdd): pass
        elif marker == 0xda:
            seen_scan = True
            while offset < len(data):
                if data[offset] != 255: offset += 1; continue
                if offset + 1 >= len(data): raise ValueError('JPEG_TRUNCATED')
                if data[offset+1] == 0 or 0xd0 <= data[offset+1] <= 0xd7: offset += 2; continue
                break
        else: raise ValueError('JPEG_METADATA_REQUIRES_REVIEW')
    raise ValueError('JPEG_TRUNCATED')


class Exporter:
    def __init__(self, spec, destination):
        self.spec = spec; self.destination = Path(destination).resolve(); self.entries = []; self.names = set()
        self.images = spec.get('image_reviews', {})
        self.prune = [(re.compile(r['pattern']),r['reason']) for r in spec.get('prune_directories',[])]
        self.rules = [(re.compile(r['pattern']), r['reason']) for r in spec.get('exclusions', [])]
        if self.destination.exists(): raise ValueError('OUTPUT_EXISTS')
        # Output must not be a scanned descendant, even when a rule would skip it.
        for source in spec['sources']:
            root = Path(source['path']).resolve()
            if self.destination == root or root in self.destination.parents: raise ValueError('OUTPUT_INSIDE_SOURCE')
        self.destination.mkdir(parents=True)
        (self.destination/'objects').mkdir()
        (self.destination/'pending').mkdir()

    def exclusion(self, name):
        if DENIED.search(name): return 'credential_or_private_installation_identity: content not read'
        for pattern, reason in self.rules:
            if pattern.search(name): return reason
        return None

    def record(self, name, **fields):
        name = safe_name(name)
        if name in self.names: raise ValueError('DUPLICATE_LOGICAL_PATH')
        self.names.add(name); self.entries.append({'path': name, **fields})

    def content(self, name, data, depth=0, **origin):
        original = sha(data); meta = dict(original_sha256=original, original_bytes=len(data), **origin)
        if depth > 3: self.record(name, status='blocked', reason='ARCHIVE_DEPTH', **meta); return
        if len(data) > MAX_FILE: self.record(name, status='blocked', reason='FILE_LIMIT', **meta); return
        stream = io.BytesIO(data)
        archive = None
        if zipfile.is_zipfile(stream): archive = zipfile.ZipFile(stream)
        else:
            stream.seek(0)
            try: archive = tarfile.open(fileobj=stream, mode='r:*')
            except tarfile.ReadError: pass
        if archive:
            with archive:
                zipped = isinstance(archive, zipfile.ZipFile)
                members = []
                total_size = 0
                for member in (archive.infolist() if zipped else archive):
                    members.append(member)
                    total_size += member.file_size if zipped else member.size
                    if len(members) > 20000 or total_size > MAX_ARCHIVE: break
                sizes = [x.file_size if zipped else x.size for x in members]
                if len(members) > 20000 or sum(sizes) > MAX_ARCHIVE: self.record(name, status='blocked', reason='ARCHIVE_LIMIT', **meta); return
                self.record(name, status='expanded', reason='Nested contents independently checked; original container not published', **meta)
                member_names = set()
                for member in members:
                    inner = safe_name(member.filename if zipped else member.name)
                    if inner in member_names: raise ValueError('DUPLICATE_ARCHIVE_MEMBER')
                    member_names.add(inner)
                    if (member.is_dir() if zipped else member.isdir()): continue
                    logical = name + '!/' + inner
                    mode = (member.external_attr >> 16) if zipped else member.mode
                    regular = not stat.S_ISLNK(mode) if zipped else member.isfile()
                    if not regular: self.record(logical, status='blocked', reason='ARCHIVE_LINK_OR_SPECIAL'); continue
                    reason = self.exclusion(logical)
                    if reason: self.record(logical, status='excluded', reason=reason, original_bytes=member.file_size if zipped else member.size); continue
                    size = member.file_size if zipped else member.size
                    if size > MAX_FILE: self.record(logical, status='blocked', reason='FILE_LIMIT', original_bytes=size); continue
                    raw = archive.read(member) if zipped else archive.extractfile(member).read(MAX_FILE+1)
                    self.content(logical, raw, depth+1, container_sha256=original)
            return
        try:
            if data.startswith((b'\x89PNG', b'\xff\xd8')):
                png_check(data) if data.startswith(b'\x89PNG') else jpeg_check(data)
                review = self.images.get(original)
                if not review or review.get('decision') != 'safe_project_screenshot' or not review.get('ocr_sha256'):
                    raise ValueError('IMAGE_REVIEW_REQUIRED')
                exported = data
            else: exported = sanitize_text(data)
        except (ValueError, UnicodeError) as error:
            pending=self.destination/'pending'/original
            if not pending.exists():pending.write_bytes(data)
            self.record(name, status='blocked', reason=str(error) if isinstance(error, ValueError) and not isinstance(error, UnicodeError) else 'UNKNOWN_BINARY_REQUIRES_REVIEW', **meta); return
        public_sha = sha(exported); obj = self.destination/'objects'/public_sha
        if obj.exists():
            if obj.read_bytes() != exported: raise ValueError('OBJECT_COLLISION')
        else: obj.write_bytes(exported)
        self.record(name, status='included', export_sha256=public_sha, export_bytes=len(exported), redacted=exported != data, **meta)

    def scan(self):
        for source in self.spec['sources']:
            root = Path(source['path']); prefix = safe_name(source['name'])
            if root.is_symlink(): raise ValueError('SOURCE_SYMLINK')
            if not root.exists(): raise ValueError('SOURCE_MISSING')
            def walk():
                if root.is_file():
                    yield root; return
                for folder, directories, files in os.walk(root, followlinks=False):
                    directories.sort(); files.sort()
                    for child in list(directories):
                        full=Path(folder)/child; logical=prefix+'/'+full.relative_to(root).as_posix()
                        reason=next((reason for pattern,reason in self.prune if pattern.search(logical)),None)
                        if full.is_symlink():
                            directories.remove(child);self.record(logical,status='blocked',reason='SOURCE_SYMLINK');continue
                        if reason:
                            directories.remove(child); count=0;size=0
                            for sub,ds,fs in os.walk(full,followlinks=False):
                                ds[:]=[n for n in ds if not (Path(sub)/n).is_symlink()]
                                for n in fs:
                                    q=Path(sub)/n
                                    if q.is_symlink(): continue
                                    st=q.stat();count+=1;size+=st.st_size
                            self.record(logical,status='excluded',reason=reason,original_bytes=size,logical_file_count=count,subtree=True)
                    for child in files: yield Path(folder)/child
            paths=walk()
            for file in paths:
                name = prefix if file == root else prefix + '/' + file.relative_to(root).as_posix()
                if file.is_symlink(): self.record(name, status='blocked', reason='SOURCE_SYMLINK'); continue
                if file.is_dir(): continue
                st = file.stat()
                if not stat.S_ISREG(st.st_mode): self.record(name, status='blocked', reason='SOURCE_SPECIAL'); continue
                reason = self.exclusion(name)
                if reason: self.record(name, status='excluded', reason=reason, original_bytes=st.st_size); continue
                if st.st_size > MAX_FILE: self.record(name, status='blocked', reason='FILE_LIMIT', original_bytes=st.st_size); continue
                # O_NOFOLLOW + inode/size/time check protects the read from path replacement.
                fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as f:
                    before = os.fstat(f.fileno()); data = f.read(MAX_FILE+1); after = os.fstat(f.fileno())
                now = file.stat()
                identity = lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
                if identity(st) != identity(before) or identity(before) != identity(after) or identity(after) != identity(now): raise ValueError('SOURCE_CHANGED')
                self.content(name, data, captured_mtime_ns=st.st_mtime_ns)
        summary = {status: sum(e['status'] == status for e in self.entries) for status in ['included','excluded','blocked','expanded']}
        summary.update(logical_files=sum(e.get('logical_file_count',1) for e in self.entries), unique_objects=len(list((self.destination/'objects').iterdir())), original_bytes=sum(e.get('original_bytes',0) for e in self.entries if 'container_sha256' not in e), logical_export_bytes=sum(e.get('export_bytes',0) for e in self.entries), stored_export_bytes=sum(p.stat().st_size for p in (self.destination/'objects').iterdir()))
        manifest = {'schema':SCHEMA,'captured_at':self.spec['captured_at'],'scope':self.spec['scope'],'not_a_production_restore_package':True,'entries':self.entries,'summary':summary}
        raw = encode(manifest); (self.destination/'manifest.json').write_bytes(raw)
        return {'manifest_sha256':sha(raw), **summary}


def verify(root, expected_sha):
    root=Path(root);raw=(root/'manifest.json').read_bytes()
    if sha(raw)!=expected_sha: raise ValueError('MANIFEST_HASH')
    m=json.loads(raw)
    if m.get('schema')!=SCHEMA: raise ValueError('SCHEMA')
    names=set();objects=set()
    for e in m['entries']:
        name=safe_name(e['path'])
        if name in names:raise ValueError('DUPLICATE_LOGICAL_PATH')
        names.add(name)
        if e['status']=='blocked':raise ValueError('UNRESOLVED_CONTENT')
        if e['status'] not in ('included','excluded','expanded'):raise ValueError('ENTRY_STATUS')
        if e['status']=='included':
            h=e['export_sha256']
            if not re.fullmatch('[a-f0-9]{64}',h):raise ValueError('OBJECT_NAME')
            p=root/'objects'/h
            if p.is_symlink():raise ValueError('OBJECT_SYMLINK')
            b=p.read_bytes()
            if sha(b)!=h or len(b)!=e['export_bytes']:raise ValueError('OBJECT_HASH')
            objects.add(h)
    if {p.name for p in (root/'objects').iterdir()}!=objects:raise ValueError('UNREFERENCED_OR_MISSING_OBJECT')
    return m


def bundle(root, expected_sha, destination, limit=480*1024*1024):
    """Package only verified manifest and referenced objects, never pending files."""
    root=Path(root); destination=Path(destination)
    m=verify(root,expected_sha)
    if destination.exists():raise ValueError('OUTPUT_EXISTS')
    destination.mkdir(parents=True)
    paths=['manifest.json']+['objects/'+h for h in sorted({e['export_sha256'] for e in m['entries'] if e['status']=='included'})]
    groups=[]; group=[]; size=0
    for name in paths:
        estimate=(root/name).stat().st_size+2048
        if estimate>limit:raise ValueError('VOLUME_FILE_LIMIT')
        if group and size+estimate>limit:groups.append(group);group=[];size=0
        group.append(name);size+=estimate
    if group:groups.append(group)
    parts=[]
    for number,group in enumerate(groups,1):
        target=destination/f'materials-{number:02d}.zip'
        with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_STORED) as archive:
            for name in group:
                raw=(root/name).read_bytes()
                expected=expected_sha if name=='manifest.json' else name.split('/')[1]
                if sha(raw)!=expected:raise ValueError('SOURCE_CHANGED_DURING_BUNDLE')
                info=zipfile.ZipInfo(name,(2026,1,1,0,0,0));info.external_attr=0o100644<<16
                archive.writestr(info,raw)
        with zipfile.ZipFile(target) as archive:
            if archive.namelist()!=group or archive.testzip() is not None:raise ValueError('VOLUME_VERIFY')
        parts.append({'name':target.name,'sha256':sha(target.read_bytes()),'bytes':target.stat().st_size,'members':group})
    index={'schema':'MFV:PUBLIC_VOLUMES:v1','manifest_sha256':expected_sha,'not_a_production_restore_package':True,'parts':parts}
    raw=encode(index);(destination/'volumes.json').write_bytes(raw)
    return {'index_sha256':sha(raw),'parts':len(parts),'bytes':sum(p['bytes'] for p in parts)}


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    a=sub.add_parser('prepare');a.add_argument('spec');a.add_argument('destination')
    a=sub.add_parser('verify');a.add_argument('directory');a.add_argument('manifest_sha256')
    a=sub.add_parser('bundle');a.add_argument('directory');a.add_argument('manifest_sha256');a.add_argument('destination')
    args=p.parse_args()
    if args.command=='prepare':print(json.dumps(Exporter(json.loads(Path(args.spec).read_text()),args.destination).scan()))
    elif args.command=='bundle':print(json.dumps(bundle(args.directory,args.manifest_sha256,args.destination)))
    else:
        m=verify(args.directory,args.manifest_sha256);print(json.dumps({'verified':True,'summary':m['summary']}))
if __name__=='__main__':main()
