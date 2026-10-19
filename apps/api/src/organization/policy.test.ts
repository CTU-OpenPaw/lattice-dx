// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { parseDepartmentCreate, parseDepartmentUpdate, parseSnapshot, requireManager, canonicalSnapshot } from './policy.js';
test('strict department input requires explicit nullable references and rejects authority fields',()=>{
  expect(parseDepartmentCreate({
    id:'finance',name:' Finance ',parentId:null,managerId:null
  })).toEqual({
    id:'finance',name:'Finance',parentId:null,managerId:null
  });
  for (const body of [{
    id:'f',name:'F'
  }, {
    id:'f',name:'F',parentId:null,managerId:null,organizationId:'other'
  },{
    id:'bad id',name:'F',parentId:null,managerId:null
  }
  ])expect(()=>parseDepartmentCreate(body)).toThrow();
  expect(()=>parseDepartmentUpdate({
    expectedVersion:0,name:'F',parentId:null,managerId:null
  })).toThrow();
});
test('snapshot bounds unique subjects roles and rejects credentials',()=>{
  const person={
    subject:'alice',displayName:' Alice ',roles:['writer','reader'],enabled:true
  };
  expect(parseSnapshot({
    expectedRevision:0,people:[person]
  }).people[0].displayName).toBe('Alice');
  for (const people of [[person,person],[{
    ...person,password:'secret'
  }
  ],[{
    ...person,roles:['a','a']
  }
  ],Array.from({
    length:201
  },(_,i)=>({
    ...person,subject:String(i)
  }))])expect(()=>parseSnapshot({
    expectedRevision:0,people
  })).toThrow();
  expect(canonicalSnapshot(parseSnapshot({
    expectedRevision:0,people:[person]
  }))).toContain('"roles":["reader","writer"]');
});
test('only signed management role grants snapshot authority',()=>{
  expect(()=>requireManager({
    subject:'alice',organizationId:'org',roles:['directory:read']
  })).toThrow();
  expect(()=>requireManager({
    subject:'alice',organizationId:'org',roles:['directory:manage']
  })).not.toThrow();
});
test('opaque Unicode subjects have deterministic snapshot ordering',()=>{
 const people=['é','e\u0301'].map(subject=>({subject,displayName:subject,roles:[],enabled:true}));
 expect(canonicalSnapshot({expectedRevision:0,people})).toBe(canonicalSnapshot({expectedRevision:0,people:[...people].reverse()}));
});
