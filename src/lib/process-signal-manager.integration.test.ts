import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Node and Bun continue consuming real piped stdin after detach and failed attach', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-ownership-'));
  try {
    const fixture = join(dir, 'fixture.ts');
    await writeFile(
      fixture,
      `
      import {ProcessSignalManager} from ${JSON.stringify(new URL('./process-signal-manager.ts', import.meta.url).pathname)};
      let data='';
      process.stdin.on('data', chunk=>{data+=chunk;});
      const manager=new ProcessSignalManager({onReloadRequested(){}});
      const original=process.on;
      if(process.argv[2]==='fail') process.on=function(event,...args){if(event==='SIGHUP')throw new Error('registration refused');return original.call(this,event,...args);};
      try {manager.attach();manager.detach();} catch {} finally {process.on=original;}
      setTimeout(()=>{console.log(data);process.exit(0);},50);
    `,
    );
    const bundle = join(dir, 'fixture.mjs');
    const build = await Bun.build({ entrypoints: [fixture], target: 'node' });
    expect(build.success).toBe(true);
    await writeFile(bundle, await build.outputs[0].text());
    for (const runtime of ['node', process.execPath]) {
      for (const mode of ['detach', 'fail']) {
        const result = spawnSync(runtime, [bundle, mode], {
          input: 'still-flowing',
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('still-flowing');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
