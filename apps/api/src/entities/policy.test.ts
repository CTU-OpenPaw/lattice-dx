// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { parseSchema, validateAttributes, canonicalJson, EntityError } from './policy.js';

const definition = { id: 'invoice', title: 'Invoice', fields: {
  label: { type: 'text', required: true, maxLength: 8 },
  paid: { type: 'boolean' }, count: { type: 'integer' },
  amount: { type: 'decimal' }, due: { type: 'date' },
  state: { type: 'enum', choices: ['open', 'closed'] },
}, relations: { parent: { targetSchemaId: 'invoice' } } };

test('schema declares only bounded safe typed fields and relations', () => {
  expect(parseSchema(definition)).toEqual(definition);
  for (const invalid of [
    { ...definition, ownerId: 'alice' },
    { ...definition, fields: { ownerId: { type: 'text' } } },
    { ...definition, fields: { x: { type: 'text', maxLength: 0 } } },
    { ...definition, fields: { x: { type: 'enum', choices: ['x', 'x'] } } },
    { ...definition, fields: { x: { type: 'boolean', choices: ['x'] } } },
    { ...definition, fields: { x: { type: ['text'] } } },
    { ...definition, relations: { x: { targetSchemaId: 'bad/id' } } },
    { ...definition, relations: null },
    { ...definition, fields: Object.fromEntries(Array.from({length:51},(_,i)=>[`f${i}`,{type:'text'}])) },
  ]) expect(() => parseSchema(invalid)).toThrow(EntityError);
});

test('storage validation bounds serialized UTF-8 attributes independently of HTTP', () => {
  const schema=parseSchema({id:'sample',title:'Sample',fields:{a:{type:'text'},b:{type:'text'}}});
  expect(()=>validateAttributes(schema,{a:'界'.repeat(4000),b:'界'.repeat(4000)})).toThrow(EntityError);
});

test('optional field names do not read inherited object properties', () => {
  const schema=parseSchema({id:'sample',title:'Sample',fields:{toString:{type:'text'}}});
  expect(validateAttributes(schema,{})).toEqual({});
});

test('attributes preserve decimal precision and enforce real dates and exact types', () => {
  const schema = parseSchema(definition);
  const attributes = { label: 'A', paid: false, count: 2, amount: '0.0100', due: '2024-02-29', state: 'open' };
  expect(validateAttributes(schema, attributes)).toEqual(attributes);
  for (const bad of [
    {}, { label:' ' }, {label:'012345678'}, {label:'A',paid:'true'},
    {label:'A',count:1.2}, {label:'A',count:Number.MAX_SAFE_INTEGER+1},
    {label:'A',amount:0.1}, {label:'A',amount:'1e3'}, {label:'A',amount:'9'.repeat(39)},
    {label:'A',due:'2023-02-29'}, {label:'A',due:'2024-04-31'},
    {label:'A',state:'unknown'}, {label:'A',extra:1}, {label:'A',ownerId:'bob'},
  ]) expect(() => validateAttributes(schema, bad)).toThrow(EntityError);
});

test('typed canonical JSON sorts recursive keys without coercing primitive values', () => {
  expect(canonicalJson({b:{z:false,a:'0.0100'},a:2})).toBe(canonicalJson({a:2,b:{a:'0.0100',z:false}}));
  expect(canonicalJson({x:1})).not.toBe(canonicalJson({x:'1'}));
  expect(canonicalJson({x:'0.10'})).not.toBe(canonicalJson({x:'0.1'}));
});
