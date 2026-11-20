import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { SshConnection, fingerprintHostKey } from '../src/ssh/SshConnection.js';
import { isSafeSshAlias, knownHostKeys, listSshConfigAliases, parseSshG, sshEnv } from '../src/ssh/sshConfig.js';
import type { CommandRunner } from '../src/ddev/runner.js';

const { Server, utils } = ssh2;

describe('reading the ssh config', () => {
  it('lists Host aliases, following Include, and skips patterns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-sshcfg-'));
    await fs.mkdir(path.join(dir, 'conf.d'));
    await fs.writeFile(path.join(dir, 'conf.d', 'a.conf'), 'Host included-one\n  HostName 203.0.113.5\n');
    await fs.writeFile(
      path.join(dir, 'config'),
      `# comment\nHost example-server other-alias\n  HostName server.example.com\nHost *.internal !bad\n  User x\nHost -oProxyCommand=evil\nInclude ${path.join(dir, 'conf.d', '*.conf')}\n`,
    );
    expect(await listSshConfigAliases(path.join(dir, 'config'))).toEqual(['example-server', 'other-alias', 'included-one']);
    expect(await listSshConfigAliases(path.join(dir, 'missing'))).toEqual([]);
    expect(isSafeSshAlias('-oProxyCommand=evil')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads what ssh -G resolved', () => {
    const out = [
      'user deploy',
      'hostname server.example.com',
      'port 2222',
      'identityfile ~/.ssh/id_rsa',
      'identityfile ~/.ssh/id_ed25519_example',
      'userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2',
      'globalknownhostsfile /etc/ssh/ssh_known_hosts',
    ].join('\n');
    const h = parseSshG('example-server', out, (p) => p.endsWith('id_ed25519_example'));
    expect(h).toMatchObject({ alias: 'example-server', hostname: 'server.example.com', port: 2222, user: 'deploy', knownHostsName: '[server.example.com]:2222' });
    expect(h.identityFiles).toEqual([path.join(os.homedir(), '.ssh/id_ed25519_example')]);
    expect(h.knownHostsFiles).toContain('/etc/ssh/ssh_known_hosts');
    expect(h.proxy).toBeUndefined();
    expect(parseSshG('j', 'hostname h\nport 22\nproxyjump bastion\nhostkeyalias pinned-name').proxy).toBe('bastion');
    expect(parseSshG('j', 'hostname h\nport 22\nhostkeyalias pinned-name').knownHostsName).toBe('pinned-name');
  });

  it('gives Windows OpenSSH the variables a plugin worker lacks', () => {
    const env = sshEnv({ PATH: 'x', SystemDrive: 'D:' }, 'win32');
    expect(env['ProgramData']).toBe('D:\\ProgramData');
    expect(env['USERPROFILE']).toBe(os.homedir());
    expect(sshEnv({ PROGRAMDATA: 'E:\\Data', USERPROFILE: 'E:\\me' }, 'win32')).toEqual({ PROGRAMDATA: 'E:\\Data', USERPROFILE: 'E:\\me' });
    expect(sshEnv({ PATH: 'x' }, 'linux')).toEqual({ PATH: 'x' });
  });

  it('collects known_hosts keys with ssh-keygen, leaving out revoked keys and CA lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-kh-'));
    const file = path.join(dir, 'known_hosts');
    await fs.writeFile(file, 'placeholder');
    const pub = () => (utils.parseKey(utils.generateKeyPairSync('ed25519').public).getPublicSSH() as Buffer);
    const [good, bad, ca] = [pub(), pub(), pub()];
    const line = (k: Buffer, marker = '') => `${marker ? marker + ' ' : ''}server.example.com ssh-ed25519 ${k.toString('base64')}`;
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: async (_cmd, args) => {
        calls.push([...args]);
        return {
          code: 0,
          stderr: '',
          stdout: ['# Host server.example.com found: line 3', line(good), line(bad), line(bad, '@revoked'), line(ca, '@cert-authority'), 'garbage line'].join('\n'),
        };
      },
    };
    const h = parseSshG('x', 'hostname server.example.com\nport 22', () => false);
    expect(await knownHostKeys({ ...h, knownHostsFiles: [file, path.join(dir, 'missing')] }, runner)).toEqual([fingerprintHostKey(good)]);
    expect(calls).toEqual([['-F', 'server.example.com', '-f', file]]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('connecting like ssh does', () => {
  let server: InstanceType<typeof Server> | undefined;
  afterEach(() => server?.close());

  async function start(allowedKey: Buffer) {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const hostFp = fingerprintHostKey(utils.parseKey(hostKey.public).getPublicSSH() as Buffer);
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && Buffer.from(ctx.key.data).equals(allowedKey)) return ctx.accept();
        ctx.reject(['publickey']);
      });
      client.on('error', () => {});
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return { port: (server.address() as AddressInfo).port, hostFp };
  }

  it('trusts only known_hosts keys, and tries each identity file before giving up', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-keys-'));
    const encrypted = utils.generateKeyPairSync('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr', rounds: 2 });
    const wrong = utils.generateKeyPairSync('ed25519');
    const right = utils.generateKeyPairSync('ed25519');
    const files = { encrypted: path.join(dir, 'enc'), wrong: path.join(dir, 'wrong'), right: path.join(dir, 'right') };
    await fs.writeFile(files.encrypted, encrypted.private);
    await fs.writeFile(files.wrong, wrong.private);
    await fs.writeFile(files.right, right.private);
    const { port, hostFp } = await start(utils.parseKey(right.public).getPublicSSH() as Buffer);
    const target = { host: '127.0.0.1', port, username: 'deploy', auth: { kind: 'keys-then-agent' as const, keyPaths: Object.values(files) }, trustCommand: 'ssh example-server' };

    const conn = await SshConnection.connect({ ...target, knownHostKeys: [hostFp] });
    expect(conn.hostKeyFingerprint).toBe(hostFp);
    conn.close();

    await expect(SshConnection.connect({ ...target, knownHostKeys: [] })).rejects.toMatchObject({
      code: 'HOST_KEY_UNKNOWN',
      message: expect.stringContaining('"ssh example-server"'),
    });
    await expect(SshConnection.connect({ ...target, knownHostKeys: ['SHA256:someoneelse'] })).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    await expect(
      SshConnection.connect({ ...target, auth: { kind: 'keys-then-agent', keyPaths: [files.wrong] }, knownHostKeys: [hostFp] }),
    ).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('marks a connection the server drops as closed, without an uncaught error', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-drop-'));
    const key = utils.generateKeyPairSync('ed25519');
    await fs.writeFile(path.join(dir, 'k'), key.private);
    const hostKey = utils.generateKeyPairSync('ed25519');
    const hostFp = fingerprintHostKey(utils.parseKey(hostKey.public).getPublicSSH() as Buffer);
    const clients: Array<{ end(): void }> = [];
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      clients.push(client);
      client.on('authentication', (ctx) => ctx.accept());
      client.on('error', () => {});
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const conn = await SshConnection.connect({
      host: '127.0.0.1', port, username: 'deploy', auth: { kind: 'keys-then-agent', keyPaths: [path.join(dir, 'k')] }, knownHostKeys: [hostFp],
    });
    expect(conn.closed).toBe(false);
    clients[0]!.end();
    await expect.poll(() => conn.closed, { timeout: 5000 }).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
