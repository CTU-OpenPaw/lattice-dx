import {expect,test,vi} from 'vitest';
import {parseAutomationWorkerEnabled,startAutomationWorker} from './worker.js';
test('automation worker is explicit opt in and rejects invalid config',()=>{
 expect(parseAutomationWorkerEnabled(undefined)).toBe(false);expect(parseAutomationWorkerEnabled('false')).toBe(false);expect(parseAutomationWorkerEnabled('true')).toBe(true);
 expect(()=>parseAutomationWorkerEnabled('yes')).toThrow();
});
test('singleflight ticks and stop drains before pool can close',async()=>{
 vi.useFakeTimers();let release!:()=>void;const tickOne=vi.fn(()=>new Promise<void>(r=>{release=r;}));
 const worker=startAutomationWorker({tickOne} as never,10);try{
  await vi.advanceTimersByTimeAsync(30);expect(tickOne).toHaveBeenCalledTimes(1);
  let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);release();await stop;
  await vi.advanceTimersByTimeAsync(100);expect(tickOne).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
