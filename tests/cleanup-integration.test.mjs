import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const start=source.indexOf('    async function libraryTransition('),end=source.indexOf('    function recentDialog()',start);
assert.ok(start>0 && end>start);
const production=source.slice(start,end);
async function observe(code, success) {
  const context={undoStack:[{draft:{id:'previous',client:'unsaved older value'}}],undoGroup:'previous:client',nativeTransition:async()=>success,render(){}};
  vm.runInNewContext(code,context);assert.equal(await context.libraryTransition('open_draft',{id:'next'},'Opened'),success);return context;
}
test('opening/new/restoring from library clears undo tied to another document only after success',async()=>{
  const opened=await observe(production,true);assert.equal(opened.undoStack.length,0);assert.equal(opened.undoGroup,null);
  const failed=await observe(production,false);assert.equal(failed.undoStack.length,1);assert.equal(failed.undoGroup,'previous:client');
});
test('known cross-document Undo defect is detected in an isolated source copy',async()=>{
  const broken=production.replace('undoStack = [];','');assert.notEqual(broken,production);
  const opened=await observe(broken,true);assert.throws(()=>assert.equal(opened.undoStack.length,0));
});
