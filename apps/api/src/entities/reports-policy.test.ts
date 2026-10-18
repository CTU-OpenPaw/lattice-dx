// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'vitest';
import {parseReportInput} from './reports-policy.js';
const query={schemaId:'invoice',schemaVersion:1,metrics:[{name:'rows',operation:'count'}]};
test('strict report input normalizes title and uses aggregate bounds',()=>{
 expect(parseReportInput({title:' Report ',query}).title).toBe('Report');
 for(const body of [{title:'',query},{title:'Report',query,extra:true},{title:'Report',query:{...query,limit:1}}])expect(()=>parseReportInput(body)).toThrow();
});
