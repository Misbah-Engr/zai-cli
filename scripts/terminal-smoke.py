#!/usr/bin/env python3
"""POSIX PTY exercise of the real frontend with a synthetic, credential-free RPC child.
This is not a live Z.ai test. Pass --entry /installed/bin/zc.mjs to test a package install.
"""
import argparse, fcntl, json, os, pathlib, pty, re, select, shutil, struct, subprocess, tempfile, termios, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(); parser.add_argument('--entry', default=str(ROOT / 'bin/zc.mjs')); parser.add_argument('--output')
args = parser.parse_args(); node = shutil.which('node')
if os.name != 'posix' or not node:
    raise SystemExit('This smoke test requires POSIX, Python 3, and Node.')

def run():
    with tempfile.TemporaryDirectory(prefix='zc-pty-') as tmp:
        home = pathlib.Path(tmp); state = home / 'state'; state.mkdir()
        log = home / 'requests.jsonl'
        config = {'runtime': {'command': node, 'args': [str(ROOT / 'test/fixtures/workbench-runtime.mjs')]}, 'theme': 'light', 'requestTimeoutMs': 1000}
        (state / 'config.json').write_text(json.dumps(config))
        master, slave = pty.openpty(); before = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
        env = dict(os.environ, ZC_HOME=str(state), ZC_FIXTURE_LOG=str(log), TERM='xterm-256color'); env.pop('NO_COLOR', None)
        child = subprocess.Popen([node, args.entry, '--trust', '--cwd', tmp], stdin=slave, stdout=slave, stderr=slave, env=env)
        data = bytearray(); chunks = []
        def pump(seconds=.15):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                ready, _, _ = select.select([master], [], [], min(.05, max(0, until - time.monotonic())))
                if ready:
                    try: b = os.read(master, 65536)
                    except OSError: break
                    if not b: break
                    data.extend(b); chunks.append(b)
        def send(text): os.write(master, text.encode()); pump()
        def paste(text): send('\x1b[200~' + text + '\x1b[201~')
        def requests():
            return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        def wait_for(predicate, timeout=6):
            until = time.monotonic() + timeout
            while not predicate():
                if time.monotonic() > until: raise AssertionError('Timed out waiting for fixture condition. Tail: ' + bytes(data[-3000:]).decode(errors='replace'))
                pump(.1)
        checks = []
        try:
            wait_for(lambda: any(r.get('method') == 'session/subscribe' for r in requests())); pump(.4)
            assert b'1002h' in data and b'1006h' in data
            paste('first task'); assert not any(r.get('method') == 'session/send' for r in requests())
            send('\r'); wait_for(lambda: any(r.get('method') == 'session/send' for r in requests())); pump(.5)
            assert b'History line 89' in data; checks.append('streamed synthetic response rendered')
            paste('alpha beta gamma'); pump(.2)
            # 120x32 frame has one draft row at terminal row 29, text begins column 5.
            send('\x1b[<0;11;29M'); send('\x1b[<32;15;29M'); send('\x1b[<0;15;29m'); send('\x7f')
            # Delete beta, then undo/redo, and keep the resulting unsent draft.
            send('\x1a'); send('\x19')
            for _ in range(8): send('\x1b[<64;20;12M')
            send('\x1b[A'); send('\x1b[B'); send('\x1b[1;5F'); checks.append('mouse selection, deletion, undo/redo, wheel navigation exercised')
            # Select all and replacement never submits without Enter.
            send('\x01'); paste('quiet'); send('\r')
            wait_for(lambda: sum(r.get('method') == 'session/send' for r in requests()) == 2)
            pump(2.6)
            assert any(r.get('method') == 'session/read' for r in requests()), 'silence did not trigger a health check'
            assert not any(r.get('method') == 'session/stop' for r in requests()), 'quiet task was stopped automatically'
            checks.append('quiet active turn survived multiple health intervals without stop or replay')
            send('\x1b'); pump(.4); wait_for(lambda: any(r.get('method') == 'session/stop' for r in requests()))
            checks.append('explicit Esc cancelled the task')
            # Editor selection and retained draft after resize.
            paste('alpha beta gamma'); send('\x1b[<0;11;29M'); send('\x1b[<32;15;29M'); send('\x1b[<0;15;29m'); send('\x7f')
            for rows, cols in [(24, 80), (32, 120)]:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0)); child.send_signal(__import__('signal').SIGWINCH); pump(.25)
            send('\x03'); send('\x03'); pump(.3)
            child.wait(timeout=8); pump(.1)
            assert child.returncode == 0, child.returncode
            drafts = list((state / 'drafts').glob('*.json')); draft = json.loads(drafts[0].read_text())['text']
            assert draft == 'alpha  gamma', repr(draft)
            after = termios.tcgetattr(slave)
            assert before[3] & (termios.ICANON | termios.ECHO) == after[3] & (termios.ICANON | termios.ECHO)
            for control in [b'1002l', b'1006l', b'2004l', b'1049l', b'25h']: assert control in data, control
            assert not list(state.rglob('*.lock')), 'archive lock survived clean exit'
            checks += ['mouse range deletion verified in saved draft', 'resizing retained draft', 'terminal and archive locks restored']
            sent = [r['params']['content'] for r in requests() if r.get('method') == 'session/send']
            assert sent == ['first task', 'quiet'], sent
            return {'fixture': True, 'entry': args.entry, 'exitCode': child.returncode, 'checks': checks, 'modelRequests': 0, 'bytesCaptured': len(data)}
        finally:
            if child.poll() is None: child.kill(); child.wait()
            os.close(master); os.close(slave)
result = run()
text = json.dumps(result, indent=2); print(text)
if args.output: pathlib.Path(args.output).write_text(text + '\n')
