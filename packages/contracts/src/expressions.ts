// SPDX-License-Identifier: Apache-2.0
export type ScalarType = 'text'|'integer'|'decimal'|'boolean'|'date'|'enum'|'null';
export type TypedScalar = {type:'text'|'decimal'|'date'|'enum';value:string}|{type:'integer';value:number}|{type:'boolean';value:boolean}|{type:'null';value:null};
export type Expression =
  | {op:'literal';value:TypedScalar}
  | {op:'ref';source:'data'|'input';field:string;as:Exclude<ScalarType,'null'>}
  | {op:'ref';source:'projection'|'evaluation';stepId:string;field:string}
  | {op:'add'|'subtract'|'multiply'|'divide'|'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'all'|'any'|'not'|'coalesce';args:Expression[]};
