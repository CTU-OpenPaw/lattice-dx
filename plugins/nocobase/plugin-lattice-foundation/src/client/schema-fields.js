/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Both record Forms and workflow Forms render configured fields through this function.
function createFieldRenderer(React){
  const h=React.createElement;
  return function renderField({name,title,kind='string',required=false,maxLength,maximum=1000000,value='',disabled=false,onChange,options,suggestions,error,id,extra,hint}){
    const props={name,id,'aria-label':title,'aria-required':required,'aria-invalid':!!error,'aria-describedby':error?id+'-error':undefined,required,disabled,value,onChange:e=>onChange(e.target.value),style:{display:'block',width:'100%',boxSizing:'border-box',padding:8,marginTop:6,border:'1px solid '+(error?'#b42318':'#cad5e2'),borderRadius:6}};
    const control=options?h('select',props,h('option',{value:''},'Chọn…'),...options.map(item=>h('option',{key:item.value,value:item.value},item.label)))
      :kind==='text'?h('textarea',{...props,rows:3})
      :h('input',{...props,type:kind==='positiveInteger'?'number':'text',...(kind==='positiveInteger'?{min:1,max:maximum,step:1}:{}),...(suggestions?{list:id+'-choices'}:{})});
    return h('div',{key:name,style:{marginBottom:14}},h('label',{htmlFor:id},title+(required?' *':'')),control,
      suggestions&&h('datalist',{id:id+'-choices'},...suggestions.map(item=>h('option',{key:item.value,value:item.value},item.label))),
      hint&&h('small',null,hint),error&&h('p',{id:id+'-error',role:'alert',style:{color:'#b42318',margin:'5px 0'}},error),extra);
  };
}
function workflowFieldErrors(action,values){
  const errors={};
  for(const [name,kind] of Object.entries(action.fields)){
    const value=typeof values[name]==='string'?values[name].trim():'';
    if(!value)errors[name]='Vui lòng nhập trường bắt buộc.';
    else if(Array.from(value).length>(kind==='text'?2000:100))errors[name]='Nội dung vượt quá độ dài cho phép.';
    else if(kind==='file'&&! /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))errors[name]='Chọn tệp đã quét sạch hoặc nhập ID tệp hợp lệ.';
    else if(kind==='positiveInteger'&&(! /^[1-9][0-9]*$/.test(value)||Number(value)>1000000))errors[name]='Nhập số nguyên dương không quá 1000000.';
  }
  return errors;
}
module.exports={createFieldRenderer,workflowFieldErrors};
