#!/usr/bin/env python3
"""Exercise POSIX installer transactions using a synthetic dependency and engine wrapper.
No Node download, public-registry install, OAuth, or real ZCode execution is tested here.
Run as an ordinary user. Pass a packed ZC tarball and a separately packed synthetic
zcode-app-cli fixture. The production release never includes that fixture tarball.
"""
import argparse, hashlib, json, os, pathlib, platform, shutil, subprocess, tempfile
p = argparse.ArgumentParser(); p.add_argument('--package', required=True); p.add_argument('--fixture', required=True); p.add_argument('--output')
a = p.parse_args(); root = pathlib.Path(__file__).resolve().parent.parent
if os.getuid() == 0: raise SystemExit('Run this test as an ordinary user, not root.')
node = shutil.which('node'); npm = os.path.realpath(shutil.which('npm'))
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix="zc installer 'fixture' ") as tmp:
    home = pathlib.Path(tmp); state = home / 'state'; state.mkdir()
    osname = 'darwin' if platform.system() == 'Darwin' else 'linux'; arch = 'arm64' if platform.machine() in ('arm64', 'aarch64') else 'x64'
    base = home / '.local/share/zc'; engine = base / ('engines/node-v24.22.0-' + osname + '-' + arch)
    (engine / 'bin').mkdir(parents=True); (engine / 'lib/node_modules/npm/bin').mkdir(parents=True)
    # Only the installer's version probe is simulated. All other JS executes on the actual local Node.
    mocknode = engine / 'bin/node'; mocknode.write_text('#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo v24.22.0; else exec ' + __import__('shlex').quote(node) + ' "$@"; fi\n'); mocknode.chmod(0o755)
    mocknpm = engine / 'lib/node_modules/npm/bin/npm-cli.js'
    mocknpm.write_text('const {spawnSync}=require("node:child_process");\nif(process.env.ZC_FIXTURE_NPM_FAIL)process.exit(61);\nconst r=spawnSync('+json.dumps(node)+',['+json.dumps(npm)+',...process.argv.slice(2),'+json.dumps(str(pathlib.Path(a.fixture).resolve()))+'],{stdio:"inherit",env:{...process.env,npm_config_offline:"true"}});process.exit(r.status??1);\n')
    tools = home / 'tools'; tools.mkdir(); mv = tools / 'mv'
    mv.write_text('#!/usr/bin/env bash\nlast="${@: -1}"\nif [ "${ZC_FIXTURE_MV_FAIL:-}" = 1 ] && [ "$last" = "$HOME/.local/bin/zc" ]; then exit 73; fi\nexec /bin/mv "$@"\n'); mv.chmod(0o755)
    env = dict(os.environ, HOME=str(home), ZC_HOME=str(state), XDG_DATA_HOME=str(home / '.local/share'), PATH=str(tools)+':'+os.environ['PATH'], npm_config_cache=str(home/'npm-cache'), npm_config_offline='true', npm_config_engine_strict='false', SHELL='/bin/bash')
    creds = home / '.zcode/v2/credentials.json'; creds.parent.mkdir(parents=True); creds.write_text('{"synthetic":"do-not-touch"}')
    (state/'config.json').write_text(json.dumps({'theme':'dark','runtime':{'command':'/previous/runtime','args':[]},'backend':'native'}))
    launcher = home / '.local/bin/zc'; launcher.parent.mkdir(parents=True); launcher.write_text('#!/bin/sh\necho previous-launcher\n'); launcher.chmod(0o755)
    before_creds = digest(creds)
    def install(extra=None):
        return subprocess.run(['bash', str(root/'install/install.sh'), '--package', str(pathlib.Path(a.package).resolve()), '--add-path'], env={**env, **(extra or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    result = install(); assert result.returncode == 0, result.stdout
    assert subprocess.check_output([str(launcher),'--version'],env=env,text=True).strip() == '0.2.0'
    config = json.loads((state/'config.json').read_text()); assert config['runtime']['command']=='managed' and config['theme']=='dark'
    assert 'ZC launcher PATH' in (home/'.bashrc').read_text(); assert digest(creds)==before_creds
    baseline_launcher = digest(launcher)
    config['backend']='zai'; (state/'config.json').write_text(json.dumps(config)); baseline_config=json.loads((state/'config.json').read_text())
    failure = install({'ZC_FIXTURE_MV_FAIL':'1'}); assert failure.returncode!=0, failure.stdout
    assert digest(launcher)==baseline_launcher; assert json.loads((state/'config.json').read_text())==baseline_config
    failure2 = install({'ZC_FIXTURE_NPM_FAIL':'1'}); assert failure2.returncode!=0
    assert digest(launcher)==baseline_launcher; assert json.loads((state/'config.json').read_text())==baseline_config; assert digest(creds)==before_creds
    assert not list((base/'releases').glob('.install.*'))
    report={'fixture':True,'actualNode':subprocess.check_output([node,'--version'],text=True).strip(),'simulatedEngineVersionProbe':'v24.22.0','runtimeDependency':'synthetic fixture, not the upstream package','checks':['fresh staged install commits a working zc launcher','paths with spaces and apostrophes are quoted','theme retained and managed backend selected','user PATH additions written','launcher-switch failure restores ZC preferences','npm failure retains the previous launcher and preferences','synthetic credential sentinel unchanged','temporary install stages removed'],'notTested':['Node download','public npm registry','real ZCode dependency','native Windows installer','OAuth']}
    text=json.dumps(report,indent=2); print(text)
    if a.output: pathlib.Path(a.output).write_text(text+'\n')
