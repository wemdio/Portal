#!/usr/bin/env bash
# Scheduled-release helper. Tokens stay in protected files, never in arguments or output.
set -Eeuo pipefail
set +x
umask 077
fail() { printf '[eng-browser] %s\n' "$1" >&2; exit 1; }
mode=release
if [[ ${1:-} == finalize ]]; then mode=finalize; shift; fi
[[ $# == 2 ]] || fail 'Usage: release.sh [finalize] <40-character release SHA> <production directory>'
release_sha=$1; prod_dir=$2
[[ $release_sha =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid release SHA'
[[ $prod_dir == /* && -d $prod_dir ]] || fail 'Production directory must exist and be absolute'
if [[ $(id -u) != 0 ]]; then
  if [[ $mode == finalize ]]; then
    if [[ -n ${DOCKER_USERNAME:-} ]]; then exec sudo -n env "DOCKER_USERNAME=$DOCKER_USERNAME" "$0" finalize "$@"; fi
    exec sudo -n "$0" finalize "$@"
  fi
  if [[ -n ${DOCKER_USERNAME:-} ]]; then exec sudo -n env "DOCKER_USERNAME=$DOCKER_USERNAME" "$0" "$@"; fi
  exec sudo -n "$0" "$@"
fi
command -v docker >/dev/null && command -v python3 >/dev/null && command -v flock >/dev/null && command -v timeout >/dev/null || fail 'Missing docker, python3, flock or timeout'
prod_env="$prod_dir/.env"; service_dir="$prod_dir/eng-browser"; secret_file="$prod_dir/.env.eng-browser"; state_file="$prod_dir/.eng-browser-state.json"
compose_file="$service_dir/compose.yml"; profile_file="$service_dir/seccomp_profile.json"
[[ -f $prod_env && ! -L $prod_env && -f $compose_file && -f $profile_file ]] || fail 'Missing regular production env, compose or seccomp profile'
exec 9>"$prod_dir/.eng-browser-release.lock"
flock -n 9 || fail 'Another browser release is in progress'
project="portal-eng-browser-${release_sha:0:12}"
broker_host="$project-broker"
network=portal_portal-network
# Prevent shell environment from overriding the protected compose env-file.
unset ENG_BROWSER_TOKEN ENG_BROWSER_BROKER_IMAGE ENG_BROWSER_RUNNER_IMAGE ENG_BROWSER_PORTAL_NETWORK ENG_BROWSER_BROKER_HOST || true
compose_env=$(mktemp "$prod_dir/.eng-browser-compose.XXXXXX")
retained_file=$(mktemp "$prod_dir/.eng-browser-retained.XXXXXX")
cleanup() { rm -f "$compose_env" "$retained_file"; }
trap cleanup EXIT

# Prepare or verify the stable token, without sourcing the env or printing values.
python3 - "$prod_env" "$secret_file" "$mode" <<'PY'
import os,re,secrets,sys,tempfile
prod,secret,mode=sys.argv[1:]
def values(path):
    out={}
    if not os.path.exists(path): return out
    if os.path.islink(path) or not os.path.isfile(path): raise SystemExit('Unsafe env file')
    for line in open(path,encoding='utf-8'):
        m=re.fullmatch(r'\s*(?:export\s+)?(ENG_BROWSER_ENABLED|ENG_BROWSER_TOKEN)\s*=\s*(.*?)\s*',line.rstrip('\n'))
        if not m: continue
        key,value=m.groups()
        if key in out: raise SystemExit('Duplicate browser setting')
        if len(value)>=2 and value[0]==value[-1] and value[0] in "\"'": value=value[1:-1]
        out[key]=value
    return out
p=values(prod); s=values(secret); a=p.get('ENG_BROWSER_TOKEN',''); b=s.get('ENG_BROWSER_TOKEN','')
if a and b and a!=b: raise SystemExit('Browser tokens differ')
if p.get('ENG_BROWSER_ENABLED')=='1' and not (a or b): raise SystemExit('Enabled browser has no token')
if mode=='finalize' and not b: raise SystemExit('Browser token file is missing')
token=a or b or secrets.token_hex(32)
if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',token): raise SystemExit('Unsafe browser token format')
if os.path.exists(secret):
    os.chmod(secret,0o600)
    if b: sys.exit(0)
fd,tmp=tempfile.mkstemp(prefix='.env.eng-browser.',dir=os.path.dirname(secret))
try:
    os.fchmod(fd,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as f: f.write('ENG_BROWSER_TOKEN='+token+'\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,secret)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY

make_compose_env() {
  python3 - "$secret_file" "$compose_env" "$1" "$2" "$network" "$3" <<'PY'
import os,sys
secret,out,broker,runner,network,host=sys.argv[1:]
with open(secret,encoding='utf-8') as f: data=f.read()
with open(out,'w',encoding='utf-8') as f:
    os.fchmod(f.fileno(),0o600); f.write(data)
    if not data.endswith('\n'): f.write('\n')
    f.write('ENG_BROWSER_BROKER_IMAGE='+broker+'\nENG_BROWSER_RUNNER_IMAGE='+runner+'\nENG_BROWSER_PORTAL_NETWORK='+network+'\nENG_BROWSER_BROKER_HOST='+host+'\n')
PY
}
compose() { docker compose --project-name "$project" --env-file "$compose_env" -f "$compose_file" "$@"; }
compose_timed() { local deadline=$1; shift; timeout "$deadline" docker compose --project-name "$project" --env-file "$compose_env" -f "$compose_file" "$@"; }

if [[ $mode == finalize ]]; then
  [[ -f $state_file && ! -L $state_file ]] || fail 'Browser release state is missing'
  # Check all consumers before removing any old project; no env values are printed.
  python3 - "$prod_env" "$secret_file" "$state_file" "$project" "$broker_host" "$release_sha" <<'PY'
import json,os,re,subprocess,sys
prod,secret,state_path,project,host,sha=sys.argv[1:]
state=json.load(open(state_path)); assert state.get('active')==project and state.get('sha')==sha
settings={}
for line in open(prod,encoding='utf8'):
 m=re.fullmatch(r'\s*(?:export\s+)?(ENG_BROWSER_ENABLED|ENG_BROWSER_TOKEN|ENG_BROWSER_URL)\s*=\s*(.*?)\s*',line.rstrip('\n'))
 if m:
  k,v=m.groups(); assert k not in settings; settings[k]=v.strip('"\'')
token=open(secret,encoding='utf8').read().strip().split('=',1)[1]
assert settings.get('ENG_BROWSER_ENABLED')=='1' and settings.get('ENG_BROWSER_URL')=='http://'+host+':4100' and settings.get('ENG_BROWSER_TOKEN')==token
def container_env(d):
 env={}
 for row in d['Config'].get('Env',[]):
  if '=' not in row: continue
  k,v=row.split('=',1)
  if k in ('ENG_BROWSER_ENABLED','ENG_BROWSER_URL','ENG_BROWSER_TOKEN') and k in env: raise SystemExit('Duplicate browser settings in container')
  env[k]=v
 return env
names=['portal-worker-hypothesis-engine','portal-worker-hypothesis-engine-eng','portal-worker-baseconstructor']+['portal-worker-baseconstructor-'+str(i) for i in range(2,13)]
# New HE containers can remain in health starting for up to their configured
# start period. URL/token/process failures are immediate; only health waits.
import time
deadline=time.monotonic()+150
while True:
 remaining=deadline-time.monotonic()
 if remaining<=0: raise SystemExit('Required browser consumer health did not become ready')
 result=json.loads(subprocess.check_output(['docker','inspect',*names],text=True,stderr=subprocess.DEVNULL,timeout=min(5,remaining)))
 by_name={d['Name'].lstrip('/'):d for d in result}
 if set(by_name)!=set(names): raise SystemExit('Required browser consumers are missing')
 pending=False
 for name in names:
  d=by_name[name]; env=container_env(d)
  if env.get('ENG_BROWSER_ENABLED')!='1' or env.get('ENG_BROWSER_URL')!=settings['ENG_BROWSER_URL'] or env.get('ENG_BROWSER_TOKEN')!=token:
   raise SystemExit('Required browser consumers have not adopted the candidate')
  st=d['State']
  if not st.get('Running') or st.get('OOMKilled'): raise SystemExit('Required browser consumer is stopped or OOM-killed')
  if st.get('Health',{}).get('Status','healthy')!='healthy': pending=True
 if not pending: break
 remaining=deadline-time.monotonic()
 if remaining<=0: raise SystemExit('Required browser consumer health did not become ready')
 time.sleep(min(5,remaining))

PY
  make_compose_env unused unused "$broker_host"
  # Refuse cleanup if either active container drifted from the validated release.
  for service in eng-browser-broker eng-browser-runner; do
    active_id=$(compose ps -q "$service")
    [[ -n $active_id ]] || fail 'Current browser service is missing'
    active_image=$(docker inspect --format '{{.Image}}' "$active_id")
    active_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$active_image")
    [[ $active_revision == "$release_sha" ]] || fail 'Current browser service revision changed'
  done
  # Current broker must still be healthy before retiring the previous service.
  compose_timed 5 exec -T eng-browser-broker node -e "fetch('http://127.0.0.1:4100/health',{signal:AbortSignal.timeout(2000)}).then(async r=>{const v=await r.json();process.exit(r.ok&&v.ready===true?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1 || fail 'Current browser service is not healthy'
  # Collect only project names, never endpoints or credentials. Unknown URL/token
  # state fails closed by retaining every previous project.
  referenced_projects=$(python3 - "$prod_env" "$secret_file" <<'PY'
import json,re,subprocess,sys
prod,secret=sys.argv[1:]; settings={}
for line in open(prod,encoding='utf8'):
 m=re.fullmatch(r'\s*(?:export\s+)?(ENG_BROWSER_ENABLED|ENG_BROWSER_TOKEN|ENG_BROWSER_URL)\s*=\s*(.*?)\s*',line.rstrip('\n'))
 if m:
  k,v=m.groups()
  if k in settings: raise SystemExit('Duplicate browser settings')
  settings[k]=v.strip(chr(34)+chr(39))
token=open(secret,encoding='utf8').read().strip().split('=',1)[1]
ids=subprocess.check_output(['docker','ps','-q'],text=True).splitlines(); referenced=set()
for cid in ids:
 d=json.loads(subprocess.check_output(['docker','inspect',cid],text=True,stderr=subprocess.DEVNULL))[0]
 if d.get('Config',{}).get('Labels',{}).get('com.docker.compose.project','').startswith('portal-eng-browser-'): continue
 env={}
 for row in d['Config'].get('Env',[]):
  if '=' not in row: continue
  k,v=row.split('=',1)
  if k in ('ENG_BROWSER_ENABLED','ENG_BROWSER_URL','ENG_BROWSER_TOKEN') and k in env: raise SystemExit('Duplicate browser settings in container')
  env[k]=v
 if env.get('ENG_BROWSER_ENABLED')!='1': continue
 url=env.get('ENG_BROWSER_URL','')
 if url==settings['ENG_BROWSER_URL']:
  if env.get('ENG_BROWSER_TOKEN')!=token: print('UNKNOWN'); sys.exit(0)
  continue
 match=re.fullmatch(r'http://(portal-eng-browser-[a-f0-9]{12})-broker:4100',url)
 if not match: print('UNKNOWN'); sys.exit(0)
 referenced.add(match.group(1))
for project in sorted(referenced): print(project)
PY
  ) || fail 'Cannot verify other running browser consumers'
  if [[ $referenced_projects == UNKNOWN ]]; then
    printf '[eng-browser] Retirement deferred: a running consumer has an unknown endpoint or token.\n'
    exit 0
  fi
  previous_projects=$(python3 - "$state_file" "$project" <<'PY'
import json,re,sys
s=json.load(open(sys.argv[1])); current=sys.argv[2]; prior=s.get('previous',[])
if not isinstance(prior,list) or len(prior)>50: raise SystemExit('Invalid project history')
for p in prior:
 if not isinstance(p,str) or not re.fullmatch(r'portal-eng-browser-[a-f0-9]{12}',p) or p==current: raise SystemExit('Unsafe previous project')
 print(p)
PY
  )
  while IFS= read -r old_project; do
    [[ -n $old_project ]] || continue
    if printf '%s\n' "$referenced_projects" | grep -Fxq "$old_project"; then
      printf '%s\n' "$old_project" >> "$retained_file"
      continue
    fi
    make_compose_env unused unused "$old_project-broker"
    timeout 90 docker compose --project-name "$old_project" --env-file "$compose_env" -f "$compose_file" stop -t 30 eng-browser-broker eng-browser-runner >/dev/null
    timeout 90 docker compose --project-name "$old_project" --env-file "$compose_env" -f "$compose_file" rm -f eng-browser-broker eng-browser-runner >/dev/null
    printf '[eng-browser] Retired previous project %s.\n' "$old_project"
  done <<< "$previous_projects"
  python3 - "$state_file" "$project" "$retained_file" <<'PY'
import json,os,sys,tempfile
p,project,retained=sys.argv[1:]; s=json.load(open(p)); assert s['active']==project
s['previous']=[line.strip() for line in open(retained) if line.strip()]
fd,tmp=tempfile.mkstemp(prefix='.eng-browser-state.',dir=os.path.dirname(p))
try:
 os.fchmod(fd,0o600)
 with os.fdopen(fd,'w') as f: json.dump(s,f); f.write('\n'); f.flush(); os.fsync(f.fileno())
 os.replace(tmp,p)
finally:
 if os.path.exists(tmp): os.unlink(tmp)
PY
  if [[ -s $retained_file ]]; then
    printf '[eng-browser] Retirement deferred for projects still used by running consumers.\n'
  else
    printf '[eng-browser] Consumers verified; previous browser services retired.\n'
  fi
  exit 0
fi

# Refuse to create ambiguous shared Docker aliases while a legacy generic URL is active.
python3 - "$prod_env" <<'PY'
import re,sys
s={}
for line in open(sys.argv[1],encoding='utf8'):
 m=re.fullmatch(r'\s*(?:export\s+)?(ENG_BROWSER_ENABLED|ENG_BROWSER_URL)\s*=\s*(.*?)\s*',line.rstrip('\n'))
 if m: k,v=m.groups(); s[k]=v.strip('"\'')
if s.get('ENG_BROWSER_ENABLED')=='1' and not re.fullmatch(r'http://portal-eng-browser-[a-f0-9]{12}-broker:4100',s.get('ENG_BROWSER_URL','')):
 raise SystemExit('Active legacy browser URL requires a separate migration')
# Old processes may still have a generic endpoint after a previous env change.
import json,subprocess
ids=subprocess.check_output(['docker','ps','-q'],text=True).splitlines()
for cid in ids:
 d=json.loads(subprocess.check_output(['docker','inspect',cid],text=True,stderr=subprocess.DEVNULL))[0]
 env={k:v for row in d['Config'].get('Env',[]) if '=' in row for k,v in [row.split('=',1)]}
 if env.get('ENG_BROWSER_ENABLED')=='1' and env.get('ENG_BROWSER_URL')=='http://eng-browser-broker:4100':
  raise SystemExit('Live legacy generic URL requires a separate migration')
PY
registry=${DOCKER_USERNAME:-}
if [[ -z $registry ]]; then
  registry=$(python3 -c '
import re,sys
v=[]
for line in open(sys.argv[1],encoding="utf8"):
 m=re.fullmatch(r"\s*(?:export\s+)?DOCKER_USERNAME\s*=\s*(.*?)\s*",line.rstrip("\n"))
 if m: v.append(m.group(1).strip(chr(34)+chr(39)))
if len(v)!=1 or not v[0]: raise SystemExit("DOCKER_USERNAME unavailable or duplicated")
print(v[0])
' "$prod_env") || fail 'Cannot read Docker registry name' 
fi
[[ $registry =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail 'Invalid Docker registry name'
broker_image="$registry/portal-eng-browser-broker:$release_sha"; runner_image="$registry/portal-eng-browser-runner:$release_sha"
make_compose_env "$broker_image" "$runner_image" "$broker_host"
docker network inspect "$network" >/dev/null || fail 'Required Portal network is absent'
compose config --quiet || fail 'Browser compose configuration is invalid'
env_sha=$(python3 - "$prod_env" <<'PY'
import hashlib,sys
print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())
PY
)
for image in "$broker_image" "$runner_image"; do
  timeout 300 docker pull "$image" >/dev/null
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  [[ $revision == "$release_sha" ]] || fail 'Browser image revision does not match release SHA'
  [[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image") == linux/amd64 ]] || fail 'Browser image must be linux/amd64'
done
# A short project name must never alias a different full release SHA.
for existing in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
  existing_image=$(docker inspect --format '{{.Image}}' "$existing")
  existing_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$existing_image")
  [[ $existing_revision == "$release_sha" ]] || fail 'Candidate project SHA prefix collides with another release'
done
printf '[eng-browser] Verified both immutable release image revisions.\n'
# Record ownership before creating the candidate. A failed candidate remains
# discoverable for a later safe finalize; this never changes the active URL.
python3 - "$state_file" "$project" <<'PY'
import json,os,re,sys,tempfile
path,project=sys.argv[1:]
if os.path.exists(path):
 if os.path.islink(path) or not os.path.isfile(path): raise SystemExit('Unsafe state file')
 state=json.load(open(path)); previous=state.get('previous',[])
 if not isinstance(previous,list) or len(previous)>50: raise SystemExit('Invalid project history')
 if any(not isinstance(p,str) or not re.fullmatch(r'portal-eng-browser-[a-f0-9]{12}',p) for p in previous): raise SystemExit('Invalid previous project')
else:
 state={'active':None,'sha':None,'previous':[]}; previous=state['previous']
if project!=state.get('active') and project not in previous:
 if len(previous)>=50: raise SystemExit('Browser history is full; finalize first')
 previous.append(project)
state['previous']=previous
fd,tmp=tempfile.mkstemp(prefix='.eng-browser-state.',dir=os.path.dirname(path))
try:
 os.fchmod(fd,0o600)
 with os.fdopen(fd,'w') as f: json.dump(state,f); f.write('\n'); f.flush(); os.fsync(f.fileno())
 os.replace(tmp,path)
finally:
 if os.path.exists(tmp): os.unlink(tmp)
PY
compose run --rm --no-deps sockets-init >/dev/null
compose up -d --no-deps eng-browser-broker eng-browser-runner >/dev/null
broker_id=$(compose ps -q eng-browser-broker); runner_id=$(compose ps -q eng-browser-runner)
[[ -n $broker_id && -n $runner_id ]] || fail 'Browser services did not start'
# Inspect without printing environment or process arguments.
docker inspect "$runner_id" | python3 -c '
import json,sys
x=json.load(sys.stdin)[0]; h=x["HostConfig"]; c=x["Config"]
assert x["State"]["Running"] and h["NetworkMode"]=="none" and not h["Privileged"]
assert "ALL" in (h.get("CapDrop") or []) and not h.get("CapAdd") and h["ReadonlyRootfs"]
assert c.get("User") in ("browser","10001","10001:10001")
mounts=x.get("Mounts",[]); sockets=[m for m in mounts if m.get("Destination")=="/sockets"]
assert len(sockets)==1 and sockets[0].get("Type")=="volume"
assert all((m.get("Destination")=="/sockets" and m.get("Type")=="volume") or (m.get("Destination") in ("/tmp","/dev/shm") and m.get("Type")=="tmpfs") for m in mounts)
tmpfs=h.get("Tmpfs") or {}; assert set(tmpfs)=={"/tmp"}
assert any(x.lower() in ("size=128m","size=131072k","size=134217728") for x in tmpfs["/tmp"].split(","))
assert not h.get("PortBindings")
assert not any(v.startswith(("ENG_BROWSER_TOKEN=","TINYFISH_API_KEY=","SUPABASE_SERVICE_ROLE_KEY=")) for v in c.get("Env",[]))
' || fail 'Runner isolation configuration is invalid'
docker inspect "$broker_id" | python3 -c '
import json,sys
x=json.load(sys.stdin)[0]; h=x["HostConfig"]
assert x["State"]["Running"] and not h["Privileged"] and "ALL" in (h.get("CapDrop") or []) and h["ReadonlyRootfs"]
assert set(x["NetworkSettings"]["Networks"])=={"portal_portal-network"} and not h.get("PortBindings")
assert sys.argv[1] in x["NetworkSettings"]["Networks"]["portal_portal-network"].get("Aliases",[])
' "$broker_host" || fail 'Broker isolation configuration is invalid'
for running_id in "$broker_id" "$runner_id"; do
  running_image=$(docker inspect --format '{{.Image}}' "$running_id")
  running_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$running_image")
  [[ $running_revision == "$release_sha" ]] || fail 'Running browser service revision differs from the release'
done
ready=0
for ((attempt=1; attempt<=30; attempt++)); do
  if compose_timed 4 exec -T eng-browser-broker node -e "fetch('http://127.0.0.1:4100/health',{signal:AbortSignal.timeout(2000)}).then(async r=>{let v=await r.json();process.exit(r.ok&&v.ready===true?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]] || fail 'Browser service did not become ready'
# Verify the unique alias resolves to the candidate broker, without printing addresses.
compose_timed 8 exec -T eng-browser-broker node - "$broker_host" <<'NODE'
const dns=require('dns'),os=require('os');
const own=new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(x=>x.address));
dns.lookup(process.argv[2],{all:true},(err,results)=>{if(err||!results.length||results.some(x=>!own.has(x.address)))process.exit(1)});
NODE
compose_timed 8 exec -T eng-browser-runner node - <<'NODE'
const fs=require('fs'),os=require('os');
if(process.getuid()!==10001||Object.values(os.networkInterfaces()).flat().some(x=>x&&!x.internal))process.exit(1);
const status=fs.readFileSync('/proc/self/status','utf8');
if(!/^NoNewPrivs:\s*1$/m.test(status)||!/^Seccomp:\s*2$/m.test(status))process.exit(1);
let count=0;
for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){
  try {const parts=fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0');if(!/(?:chrome|chromium)/i.test(parts[0]))continue;count++;if(parts.includes('--no-sandbox'))process.exit(1);} catch {}
}
if(!count)process.exit(1);
NODE
compose_timed 25 exec -T eng-browser-broker node - <<'NODE'
(async()=>{const token=process.env.ENG_BROWSER_TOKEN;if(!token)process.exit(1);
const r=await fetch('http://127.0.0.1:4100/render',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({url:'https://quotes.toscrape.com/js/',timeoutMs:12000}),signal:AbortSignal.timeout(16000)});
const x=await r.json();if(!r.ok||x.source!=='browser'||typeof x.html!=='string'||!/<[^>]+class=["']quote["']/i.test(x.html)||!/^https:\/\/quotes\.toscrape\.com\//.test(x.url))process.exit(1);
})().catch(()=>process.exit(1));
NODE
printf '[eng-browser] Candidate sandbox, isolated network, readiness and JS rendering verified.\n'

# Record history before changing the env; finalize also verifies env/worker state,
# so a crash between these writes cannot retire a live project.
python3 - "$prod_env" "$secret_file" "$state_file" "$project" "$broker_host" "$release_sha" "$env_sha" <<'PY'
import hashlib,json,os,re,stat,sys,tempfile,time
prod,secret,state_path,project,host,sha,expected=sys.argv[1:]
st=os.stat(prod); data=open(prod,'rb').read()
if hashlib.sha256(data).hexdigest()!=expected: raise SystemExit('Production env changed during browser validation')
tokenlines=[x.rstrip('\n') for x in open(secret,encoding='utf8') if x.startswith('ENG_BROWSER_TOKEN=')]
if len(tokenlines)!=1: raise SystemExit('Invalid browser token file')
token=tokenlines[0].split('=',1)[1]
if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',token): raise SystemExit('Invalid browser token')
text=data.decode('utf8'); keys={'ENG_BROWSER_ENABLED','ENG_BROWSER_URL','ENG_BROWSER_TOKEN'}; kept=[]; current={}
for line in text.splitlines(keepends=True):
 m=re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$',line)
 if m and m.group(1) in keys:
  k,v=m.groups()
  if k in current: raise SystemExit('Duplicate browser setting')
  current[k]=v.strip('"\'')
 else: kept.append(line)
previous=[]
if os.path.exists(state_path):
 if os.path.islink(state_path) or not os.path.isfile(state_path): raise SystemExit('Unsafe state file')
 s=json.load(open(state_path)); previous=s.get('previous',[])
 if not isinstance(previous,list) or len(previous)>50: raise SystemExit('Invalid history')
 for p in previous:
  if not isinstance(p,str) or not re.fullmatch(r'portal-eng-browser-[a-f0-9]{12}',p): raise SystemExit('Invalid previous project')
old=current.get('ENG_BROWSER_URL','')
if current.get('ENG_BROWSER_ENABLED')=='1':
 m=re.fullmatch(r'http://(portal-eng-browser-[a-f0-9]{12})-broker:4100',old)
 if not m: raise SystemExit('Unsafe existing browser URL')
 if m.group(1)!=project and m.group(1) not in previous: previous.append(m.group(1))
previous=[p for p in previous if p!=project]
output=''.join(kept)
if output and not output.endswith('\n'): output+='\n'
output+='ENG_BROWSER_ENABLED=1\nENG_BROWSER_URL=http://'+host+':4100\nENG_BROWSER_TOKEN='+token+'\n'
state={'active':project,'sha':sha,'previous':previous}
def atomic(path,content,mode,owner=None):
 fd,tmp=tempfile.mkstemp(prefix='.eng-browser-update.',dir=os.path.dirname(path))
 try:
  if owner: os.fchown(fd,*owner)
  os.fchmod(fd,mode)
  with os.fdopen(fd,'wb') as f: f.write(content); f.flush(); os.fsync(f.fileno())
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
if output.encode()!=data:
 backup=prod+'.pre-eng-browser-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+str(os.getpid())
 fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
atomic(state_path,(json.dumps(state)+'\n').encode(),0o600)
if open(prod,'rb').read()!=data: raise SystemExit('Production env changed during browser activation')
if output.encode()!=data: atomic(prod,output.encode(),stat.S_IMODE(st.st_mode),(st.st_uid,st.st_gid))
PY
printf '[eng-browser] Candidate settings prepared; scheduled rollout may drain and recreate consumers.\n'
