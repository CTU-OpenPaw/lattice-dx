/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define('@latticedx/plugin-lattice-foundation', ['@nocobase/client', 'react', 'antd', '@nocobase/client-v2', 'react-router-dom', '@nocobase/flow-engine', '@ant-design/icons'], factory);
  } else if (typeof module === 'object' && module.exports) {
    let icons;
    try { icons = require('@ant-design/icons'); } catch { icons = undefined; }
    module.exports = factory(require('@nocobase/client'), require('react'), require('antd'), require('@nocobase/client-v2'), require('react-router-dom'), require('@nocobase/flow-engine'), icons);
  }
})(function (client, React, antd, clientV2, router, flow, icons) {
  'use strict';
  const actions = require('./actions');
  const {createWorkspaceComponent} = require('./workspace');
  const {createWorkspaceApi} = require('./workspace-api');
  const {createSystemScreens}=require('./system-studio');
  const {createEnterpriseConsole}=require('./enterprise-console');
  const {createBlockComponents} = require('./blocks');
  const {createApplicationRuntime} = require('./application-runtime');
  const {registerApplicationViews} = require('../applications/views');
  const {defaultContracts}=require('../shared/contracts');
  const {createNativeBuilderNavigation}=require('./native-builder-navigation');
  const {createNativePortalManager, resolveLegacyMobileRedirect}=require('./native-portal-manager');
  const {createIncidentEvidence}=require('./native-incident-evidence');
  const {createBrandLogo, registerSignInLogo}=require('./native-branding');
  const {createNotificationBellProvider}=require('./notification-bell');
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
      const mobileV2Dest = resolveLegacyMobileRedirect(typeof window !== 'undefined' ? window : null, this.app);
      if (mobileV2Dest && typeof window?.location?.replace === 'function') {
        window.location.replace(mobileV2Dest);
        return;
      }
      const BrandLogo=createBrandLogo(client,React);
      registerSignInLogo(this.app,React,BrandLogo);
      const portalManager=createNativePortalManager(client,React,antd,this.app,router,icons,{clientV2});
      await portalManager?.preloadPortals?.();
      const BuilderAdminLayout=createNativeBuilderNavigation(client,React,antd,this.app,{clientV2,router,flow,BrandLogo,portalManager});
      if (BuilderAdminLayout) this.app.addComponents({AdminLayout:BuilderAdminLayout});
      const NotificationBellProvider=createNotificationBellProvider(client,React,antd,this.app);
      if (NotificationBellProvider && typeof this.app.use === 'function') {
        this.app.use(NotificationBellProvider);
      }
      if (typeof clientV2?.ACLRolesCheckProvider === 'function' && typeof this.app.use === 'function') {
        this.app.use(clientV2.ACLRolesCheckProvider);
      }
      const SettingsTopbar = this.app.flowEngine?.getModelClass?.('PluginSettingsTopbarActionModel');
      if (SettingsTopbar?.prototype && !SettingsTopbar.prototype.aclSnippet) SettingsTopbar.prototype.aclSnippet = 'pm';
      const secSetting = this.app.pluginSettingsManager?.get?.('security');
      if (secSetting && !secSetting.aclSnippet) secSetting.aclSnippet = 'pm.security';
      if (typeof clientV2?.UserCenterActionItemModel === 'function' && typeof this.app.flowEngine?.registerModels === 'function' && !this.app.flowEngine.getModelClass?.('SignOutItemModel')) {
        class LatticeSignOutUserCenterItemModel extends clientV2.UserCenterActionItemModel {
          constructor(...args) { super(...args); this.label = 'Sign out'; this.section = 'danger'; this.sort = 100; this.danger = true; }
          async onClick() {
            let redirectUrl = this.context?.app?.getRouteUrl?.('/signin') || '/signin';
            try {
              const res = await this.context?.app?.apiClient?.auth?.signOut?.();
              redirectUrl = res?.data?.data?.redirectUrl || redirectUrl;
            } catch {}
            if (typeof window !== 'undefined' && window.location) window.location.assign(redirectUrl);
          }
        }
        LatticeSignOutUserCenterItemModel.itemId = 'lattice-sign-out';
        this.app.flowEngine.registerModels({ LatticeSignOutUserCenterItemModel });
      }
      portalManager?.ensureLayoutModelsReady?.();
      this.app.addScopes({useLatticeFormAction});
      const blocks=createBlockComponents(client,React,antd);
      this.app.addComponents({LatticeIncidentEvidence:createIncidentEvidence(client,React,antd)});
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
      class LatticeContextEntityBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'context-entity'});}
      }
      class LatticeWorkflowFormBlockModel extends clientV2.BlockModel {
        renderComponent(){return React.createElement(blocks.ConfiguredBlock,{...this.props,expectedType:'workflow-form'});}
      }
      for(const [Model,type,label] of [[LatticeFormBlockModel,'form','Lattice Form'],[LatticeListBlockModel,'list','Lattice Danh sách'],[LatticeTaskInboxBlockModel,'task-inbox','Lattice Task Inbox'],[LatticeApprovalBlockModel,'approval','Lattice Approval'],[LatticeAttachmentBlockModel,'attachment','Lattice Attachment'],[LatticeActivityTimelineBlockModel,'activity-timeline','Lattice Activity Timeline'],[LatticeContextEntityBlockModel,'context-entity','Lattice Context Entity'],[LatticeWorkflowFormBlockModel,'workflow-form','Lattice Workflow Form']]){
        Model.define({label});
        Model.registerFlow({key:'latticeBinding',title:'Cấu hình Lattice',on:'beforeRender',steps:{binding:{
          title:'Chọn ứng dụng và block',defaultParams:{binding:''},
          async uiSchema(ctx){
            const response=await ctx.api.request({url:'latticeApps:list',method:'get'});
            const apps=response.data.data.items;
            return {binding:{type:'string',title:'Ứng dụng và block',required:true,'x-decorator':'FormItem','x-component':'Select',enum:
              apps.flatMap(app=>app.blocks.filter(b=>b.type===type).map(b=>({label:app.name+' — '+b.title,value:app.id+':'+b.id})))},...(['attachment','activity-timeline','context-entity','workflow-form'].includes(type)?{contextId:{type:'string',title:'ID hồ sơ / quy trình (tùy chọn)', 'x-decorator':'FormItem','x-component':'Input'}}:{})};
          },
          handler(ctx,params){const [manifestId,blockId]=typeof params.binding==='string'?params.binding.split(':'):[];ctx.model.setProps({manifestId,blockId,...(['attachment','activity-timeline','context-entity','workflow-form'].includes(type)?{contextId:params.contextId||''}:{})});},
        }}});
      }
      this.flowEngine.registerModels({LatticeFormBlockModel,LatticeListBlockModel,LatticeTaskInboxBlockModel,LatticeApprovalBlockModel,LatticeAttachmentBlockModel,LatticeActivityTimelineBlockModel,LatticeContextEntityBlockModel,LatticeWorkflowFormBlockModel});
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
            initializer.add('otherBlocks.latticeWorkflowForm',{type:'item',title:'Lattice Workflow Form',Component:blocks.Initializer,blockType:'workflow-form'});
            initializer.add('otherBlocks.latticeContext',{type:'item',title:'Lattice Context Entity',Component:blocks.Initializer,blockType:'context-entity'});
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
      const {Studio,SystemRuntime}=createSystemScreens(client,React);
      this.app.router.add('lattice-console',{path:'/lattice/console',Component:createEnterpriseConsole(client,React)});
      this.app.router.add('lattice-studio',{path:'/lattice/studio',Component:Studio});
      this.app.router.add('lattice-systems',{path:'/lattice/systems',Component:SystemRuntime});
      this.app.router.add('lattice-system-runtime',{path:'/lattice/systems/:systemId/:version',Component:SystemRuntime});
      this.app.router.add('lattice-application',{path:'/lattice/apps/:applicationId',Component:Workspace});
      if (typeof window !== 'undefined' && window.__nocobase_app_client_entry_mode__ === 'legacy-default' && !this.app.layoutManager?.hasLayout?.('mobile') && typeof this.app.router?.add === 'function') {
        const MobileV2Redirect = () => {
          React.useEffect(() => {
            const dest = resolveLegacyMobileRedirect(window, this.app);
            if (dest && typeof window?.location?.replace === 'function') window.location.replace(dest);
          }, []);
          return React.createElement('div', { role: 'status', style: { padding: 32, textAlign: 'center', color: '#64748b' } }, 'Đang chuyển đến Cổng Di động...');
        };
        this.app.router.add('lattice-mobile-v2', { path: '/mobile', Component: MobileV2Redirect });
        this.app.router.add('lattice-mobile-v2-sub', { path: '/mobile/*', Component: MobileV2Redirect });
      }
      if (window.location.hostname === '127.0.0.1' && window.location.pathname.startsWith('/lattice')) {
        const canonical = new URL(window.location.href);canonical.hostname='localhost';
        window.location.replace(canonical.href);return;
      }
      const returnTo = sessionStorage.getItem('lattice:return-to');
      if (returnTo && window.location.pathname.startsWith('/admin')) {
        sessionStorage.removeItem('lattice:return-to');
        const safe=require('./console-model').safeReturnTo(returnTo);if(safe)window.location.replace(safe);
      }
    }
  }
  return {__esModule: true, default: LatticeFoundationClient, useLatticeFormAction, createWorkspaceApi, ...actions};
});
