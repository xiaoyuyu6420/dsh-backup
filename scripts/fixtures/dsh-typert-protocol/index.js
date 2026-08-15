// smoke 用 TypertRemoteService 桩：仅提供 name 与构造签名，满足插件导入与
// 面板服务的直接方法调用；不做 Gateway 注册（smoke 不经过 Gateway）。
export class TypertRemoteService {
  constructor(_ctx, serviceKey) {
    this.name = serviceKey;
  }
}
