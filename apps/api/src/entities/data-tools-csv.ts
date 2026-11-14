/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { bad } from './policy.js';
/** Linear RFC-style parser; content bound is checked by the caller. */
export function parseCsv(content:string):string[][] {
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false,started=false;
 function column(){if(Buffer.byteLength(cell,'utf8')>16384)bad('CSV cell exceeds 16 KiB.');row.push(cell);cell='';quoted=false;closed=false;started=false;if(row.length>51)bad('Too many CSV columns.');}
 function record(){column();rows.push(row);row=[];if(rows.length>101)bad('Import exceeds 100 rows.');}
 for(let index=0;index<content.length;index++) {
  const char=content[index];
  if(quoted){if(char==='"'){if(content[index+1]==='"'){cell+='"';index++;}else{quoted=false;closed=true;}}else cell+=char;continue;}
  if(char===','){column();continue;}
  if(char==='\n'||char==='\r'){if(char==='\r'&&content[index+1]==='\n')index++;record();continue;}
  if(closed)bad('Unexpected character after CSV quote.');
  if(char==='"'){if(started)bad('Unexpected CSV quote.');quoted=true;started=true;continue;}
  cell+=char;started=true;
 }
 if(quoted)bad('Unclosed CSV quote.');
 if(row.length||started||closed||cell.length)record();
 if(!rows.length)bad('CSV header is required.');
 return rows;
}
export function csvCell(value:string):string{return /[",\r\n]/.test(value)?`"${value.replaceAll('"','""')}"`:value;}
