// SPDX-License-Identifier: Apache-2.0
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define('@latticedx/plugin-lattice-foundation', ['@nocobase/client', 'react', 'antd', '@nocobase/client-v2'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client'), require('react'), require('antd'), require('@nocobase/client-v2'));
  }
})(function (client, React, antd, clientV2) {
  'use strict';
  const actions = require('./actions');
  const {createWorkspaceComponent} = require('./workspace');
  const {createWorkspaceApi} = require('./workspace-api');
  const {createBlockComponents} = require('./blocks');
  const {createApplicationRuntime} = require('./application-runtime');
  const {registerApplicationViews} = require('../applications/views');
  const {defaultContracts}=require('../shared/contracts');
  function useLatticeFormAction(manifest, blockId) {
    const apiClient = client.useAPIClient();
    const sharedApi = React.useMemo(() => createWorkspaceApi({apiClient}), [apiClient]);
    const controller = React.useMemo(() => actions.createFormActions({apiClient:sharedApi, manifest, blockId}), [sharedApi, manifest, blockId]);
    const [state, setState] = React.useState({loading: false, error: null, result: null});
    const submit = React.useCallback(async values => {
      if (controller.pending) throw new actions.FormActionError('BUSY', 'Yêu cầu đang được xử lý.');
      setState({loading: true, error: null, result: null});
      try {const result = await controller.submit(values); setState({loading: false, error: null, result}); return result;}
      catch (error) {setState({loading: false, error, result: null}); throw error;}
    }, [controller]);
    return {...state, submit, transition: controller.transition};
  }
  class LatticeFoundationClient extends client.Plugin {
    async load() {
      this.app.addScopes({useLatticeFormAction});
      const blocks=createBlockComponents(client,React,antd);
      class LatticeFormBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'form'});}
      }
      class LatticeListBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'list'});}
      }
      class LatticeTaskInboxBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'task-inbox'});}
      }
      class LatticeApprovalBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'approval'});}
      }
      class LatticeAttachmentBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'attachment'});}
      }
      class LatticeActivityTimelineBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'activity-timeline'});}
      }
      for(const [Model,type,label] of [[LatticeFormBlockModel,'form','Lattice Form'],[LatticeListBlockModel,'list','Lattice Danh sách'],[LatticeTaskInboxBlockModel,'task-inbox','Lattice Task Inbox'],[LatticeApprovalBlockModel,'approval','Lattice Approval'],[LatticeAttachmentBlockModel,'attachment','Lattice Attachment'],[LatticeActivityTimelineBlockModel,'activity-timeline','Lattice Activity Timeline']]){
        Model.define({label});
        Model.registerFlow({key:'latticeBinding',title:'Cấu hình Lattice',on:'beforeRender',steps:{binding:{
          title:'Chọn ứng dụng và block',defaultParams:{binding:''},
          async uiSchema(ctx){
            const response=await ctx.api.request({url:'latticeApps:list',method:'get'});
            const apps=response.data.data.items;
            return {binding:{type:'string',title:'Ứng dụng và block',required:true,'x-decorator':'FormItem','x-component':'Select',enum:
              apps.flatMap(app=>app.blocks.filter(b=>b.type===type).map(b=>({label:app.name+' — '+b.title,value:app.id+':'+b.id})))},...(['attachment','activity-timeline'].includes(type)?{contextId:{type:'string',title:'ID hồ sơ / quy trình (tùy chọn)', 'x-decorator':'FormItem','x-component':'Input'}}:{})};
          },
          handler(ctx,params){const [manifestId,blockId]=typeof params.binding==='string'?params.binding.split(':'):[];ctx.model.setProps({manifestId,blockId,...(['attachment','activity-timeline'].includes(type)?{contextId:params.contextId||''}:{})});},
        }}});
      }
      this.flowEngine.registerModels({LatticeFormBlockModel,LatticeListBlockModel,LatticeTaskInboxBlockModel,LatticeApprovalBlockModel,LatticeAttachmentBlockModel,LatticeActivityTimelineBlockModel});
      this.app.addComponents({LatticeFormBlock:blocks.FormBlock,LatticeListBlock:blocks.ListBlock,LatticeConfiguredBlock:blocks.ConfiguredBlock,LatticeBlockInitializer:blocks.Initializer});
      const registerBlocks=()=>{
        for (const name of ['page:addBlock','RecordBlockInitializers']) {
          const initializer=this.app.schemaInitializerManager.get(name);
          if (initializer) {
            initializer.add('otherBlocks.latticeForm',{type:'item',title:'Lattice Form',Component:blocks.Initializer,blockType:'form'});
            initializer.add('otherBlocks.latticeList',{type:'item',title:'Lattice Danh sách',Component:blocks.Initializer,blockType:'list'});
            initializer.add('otherBlocks.latticeTaskInbox',{type:'item',title:'Lattice Task Inbox',Component:blocks.Initializer,blockType:'task-inbox'});
            initializer.add('otherBlocks.latticeApproval',{type:'item',title:'Lattice Approval',Component:blocks.Initializer,blockType:'approval'});
            initializer.add('otherBlocks.latticeAttachment',{type:'item',title:'Lattice Attachment',Component:blocks.Initializer,blockType:'attachment'});
            initializer.add('otherBlocks.latticeTimeline',{type:'item',title:'Lattice Activity Timeline',Component:blocks.Initializer,blockType:'activity-timeline'});
          }
        }
      };
      registerBlocks();
      this.app.use(props=>{
        React.useEffect(registerBlocks,[]);
        return React.createElement(client.SchemaComponentOptions,{components:{LatticeFormBlock:blocks.FormBlock,LatticeListBlock:blocks.ListBlock,LatticeConfiguredBlock:blocks.ConfiguredBlock,LatticeBlockInitializer:blocks.Initializer}},props.children);
      });
      const runtime=createApplicationRuntime(React,blocks);
      registerApplicationViews(runtime,React);
      this.app.latticeRuntime=runtime;
      this.app.latticeContracts=defaultContracts;
      const Workspace = createWorkspaceComponent(client,React,runtime);
      this.app.router.add('lattice-workspace',{path:'/lattice',Component:Workspace});
      this.app.router.add('lattice-application',{path:'/lattice/apps/:applicationId',Component:Workspace});
      if (window.location.hostname === '127.0.0.1' && window.location.pathname.startsWith('/lattice')) {
        const canonical = new URL(window.location.href);canonical.hostname='localhost';
        window.location.replace(canonical.href);return;
      }
      const returnTo = sessionStorage.getItem('lattice:return-to');
      if (returnTo && window.location.pathname.startsWith('/admin')) {
        sessionStorage.removeItem('lattice:return-to');
        if (returnTo === '/lattice' || /^\/lattice\/apps\/[a-z][a-z0-9-]{0,63}$/.test(returnTo)) window.location.replace(returnTo);
      }
    }
  }
  return {__esModule: true, default: LatticeFoundationClient, useLatticeFormAction, createWorkspaceApi, ...actions};
});
