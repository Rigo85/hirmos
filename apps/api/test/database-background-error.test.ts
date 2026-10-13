import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({on:vi.fn(),end:vi.fn(async()=>{})}));
vi.mock('pg',()=>({default:{Pool:class {on=state.on;end=state.end;}}}));
import {createDatabase} from '../src/db/database.js';
afterEach(()=>vi.restoreAllMocks());
it('handles idle connection errors without logging the error payload or credentials',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{}),db=createDatabase('postgres://synthetic.invalid/db');
  const listener=state.on.mock.calls.find(([name])=>name==='error')![1];
  listener(Object.assign(new Error('private connection details'),{code:'ECONNRESET'}));
  expect(log).toHaveBeenCalledWith(JSON.stringify({database:{outcome:'idle_connection_error',code:'ECONNRESET'}}));
  expect(JSON.stringify(log.mock.calls)).not.toContain('private');await db.close();
});
