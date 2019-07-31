// base controller class
import 'whatwg-fetch'
import React from 'react'
// @ts-ignore
import createStore from 'relite'
// @ts-ignore
import Cookie from 'js-cookie'
import querystring, { stringify } from 'querystring'
import _ from '../util'
import ViewManager from '../component/ViewManager'
import * as shareActions from './actions'
import attachDevToolsIfPossible from './attachDevToolsIfPossible'
import {
  State,
  Actions,
  Preload,
  API,
  Model,
  Location,
  Context,
  Handlers,
  Meta,
  History,
  Matcher,
  Store,
  Loader,
  Payload
} from './types'

const REDIRECT: boolean =
  typeof Symbol === 'function'
    ? Symbol('react.imvc.redirect')
    : Object('react.imvc.redirect')

const EmptyView: React.FC = () => null
let uid: number = 0 // seed of controller id
/**
 * 绑定 Store 到 View
 * 提供 Controller 的生命周期钩子
 * 组装事件处理器 Event Handlers
 * 提供 fetch 方法
 */
interface BaseViewFC extends React.FC {
  viewId?: any
}
interface BaseViewClass extends React.ComponentClass {
  viewId?: any
}
type UdfFuncType = {
  (...args: any):any
}

export default class Controller {
  View: BaseViewFC | BaseViewClass = EmptyView
  restapi: string = ''
  preload: Preload = {}
  API: API = {}
  Model: Model = {}
  initialState: State | undefined
  actions: Actions | undefined
  SSR: boolean | { (location:Location, context: Context):boolean } = false
  KeepAliveOnPush: boolean = false
  history: History
  store: Store
  location: Location
  context: Context
  handlers: Handlers
  meta: Meta
  errorDidCatch: { (error:Error, str: string):void } | undefined
  getComponentFallback: { (displayName: string, InputComponent: any):void } | undefined
  proxyHandler: any
  [propName: string]: any

  Loading: BaseViewFC | BaseViewClass = (...args) => null
  matcher: Matcher | undefined
  loader: Loader | undefined
  getViewFallback:UdfFuncType | undefined
  getInitialState:UdfFuncType | undefined
  stateDidReuse:UdfFuncType | undefined
  getFinalActions:UdfFuncType | undefined
  shouldComponentCreate:UdfFuncType | undefined
  componentWillCreate:UdfFuncType | undefined
  refreshView:UdfFuncType | undefined
  stateDidChange:UdfFuncType | undefined
  saveToCache:UdfFuncType | undefined
  pageWillLeave:UdfFuncType | undefined
  windowWillUnload:UdfFuncType | undefined
  pageDidBack:UdfFuncType | undefined

  constructor(location: Location, context: Context) {
    this.meta = {
      id: uid++,
      isDestroyed: false,
      hadMounted: false, // change by ControllerProxy
      unsubscribeList: []
    }
    /**
     * 将 location.key 赋值给 this.meta 并在 location 里删除
     * 避免 SSR 时，因为 initialState 里总有 locaiton.key 这个随机字符串
     * 而导致服务端的 Etag 不断变化，无法 304 。
     */
    if (location) {
      this.meta.key = location.key
      delete location.key
    }
    this.location = location
    this.context = context
    this.handlers = {}
    this.history = {} as History
    this.store = {} as Store
  }
  // 绑定 handler 的 this 值为 controller 实例
  combineHandlers(source: Controller): void {
    let { handlers } = this
    Object.keys(source).forEach(key => {
      let value = source[key]
      if (key.startsWith('handle') && typeof value === 'function') {
        handlers[key] = value.bind(this)
      }
    })
  }
  // 补 basename 前缀
  prependBasename(pathname: string): string {
    if (_.isAbsoluteUrl(pathname)) {
      return pathname
    }
    let { basename } = this.context
    return basename + pathname
  }
  // 补 publicPath 前缀
  prependPublicPath(pathname: string): string {
    if (_.isAbsoluteUrl(pathname)) {
      return pathname
    }
    let { publicPath } = this.context
    return publicPath + pathname
  }

  // 处理 url 的相对路径或 mock 地址问题
  prependRestapi(url: string): string {
    let { context } = this

    /**
     * 如果已经是绝对路径
     * 在服务端直接返回 url
     * 在客户端裁剪掉 http: 使之以 // 开头
     * 让浏览器自动匹配协议，支持 Https
     */
    if (_.isAbsoluteUrl(url)) {
      if (context.isClient && url.startsWith('http:')) {
        url = url.replace('http:', '')
      }
      return url
    }

    // 对 mock 的请求进行另一种拼接，转到 node.js 服务去
    if (url.startsWith('/mock/')) {
      return this.prependBasename(url)
    }

    let restapi = this.restapi || context.restapi
    return restapi + url
  }

  /**
   * 封装重定向方法，根据 server/client 环境不同而选择不同的方式
   * isRaw 是否不拼接 Url，直接使用
   */
  redirect(redirectUrl: string, isRaw: boolean): void {
    let { history, context } = this

    if (context.isServer) {
      if (!isRaw && !_.isAbsoluteUrl(redirectUrl)) {
        // 兼容 history.push，自动补全 basename
        redirectUrl = this.prependBasename(redirectUrl)
      }
      context.res.redirect(redirectUrl)
      // 使用 throw 语句，模拟浏览器跳转时中断代码执行的效果
      // 将在外层 catch 住，并 return null 通知 create-app 无须渲染
      throw REDIRECT
    } else if (context.isClient) {
      if (isRaw || _.isAbsoluteUrl(redirectUrl)) {
        window.location.replace(redirectUrl)
      } else {
        history.replace(redirectUrl)
      }
    }
  }
  // 封装 cookie 的同构方法
  cookie(key: string, value: string, options: any): any {
    if (value == null) {
      return this.getCookie(key)
    }
    this.setCookie(key, value, options)
  }
  getCookie(key: string): string | undefined {
    let { context } = this
    if (context.isServer) {
      let { req } = context
      return req.cookies[key]
    } else if (context.isClient) {
      return Cookie.get(key)
    }
  }
  setCookie(key: string, value: string, options: any): void {
    let { context } = this

    if (options && options.expires) {
      let isDateInstance = options.expires instanceof Date
      if (!isDateInstance) {
        throw new Error(
          `cookie 的过期时间 expires 必须为 Date 的实例，而不是 ${
            options.expires
          }`
        )
      }
    }

    if (context.isServer) {
      let { res } = context
      res.cookie(key, value, options)
    } else if (context.isClient) {
      Cookie.set(key, value, options)
    }
  }
  removeCookie(key: string, options: any): void {
    let { context } = this

    if (context.isServer) {
      let { res } = context
      res.clearCookie(key, options)
    } else if (context.isClient) {
      Cookie.remove(key, options)
    }
  }

  /**
   * 封装 fetch, https://github.github.io/fetch
   * options.json === false 不自动转换为 json
   * options.timeout:number 超时时间
   * options.timeoutErrorFormatter 超时时错误信息展示格式
   * options.raw 不补全 restfulBasename
   */
  fetch(url: string, options: Record<string, any> = {}): Promise<any> {
    let { context, API } = this

    /**
     * API shortcut，方便 fetch(name, options) 代替 url
     */
    if (API && Object.prototype.hasOwnProperty.call(API, url)) {
      url = API[url]
    }

    // 补全 url
    if (!options.raw) {
      url = this.prependRestapi(url)
    }

    let finalOptions = {
      method: 'GET',
      credentials: 'include',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }
    /**
     * 浏览器端的 fetch 有 credentials: 'include'，会自动带上 cookie
     * 服务端得手动设置，可以从 context 对象里取 cookie
     */
    if (context.isServer && finalOptions.credentials === 'include') {
      finalOptions.headers['Cookie'] = context.req.headers.cookie || ''
    }

    let fetchData: Promise<any> = fetch(url, finalOptions as RequestInit)

    /**
     * 拓展字段，如果手动设置 options.json 为 false
     * 不自动 JSON.parse
     */
    if (options.json !== false) {
      fetchData = fetchData.then(_.toJSON)
    }

    /**
     * 设置自动化的超时处理
     */
    if (typeof options.timeout === 'number') {
      let { timeoutErrorFormatter } = options
      let timeoutErrorMsg =
        typeof timeoutErrorFormatter === 'function'
          ? timeoutErrorFormatter({ url, options: finalOptions })
          : timeoutErrorFormatter
      fetchData = _.timeoutReject(fetchData, options.timeout, timeoutErrorMsg)
    }

    return fetchData
  }
  /**
   *
   * 封装 get 请求，方便使用
   */
  get(url: string, params: object, options: object): Promise<any> {
    let { API } = this
    /**
     * API shortcut，方便 fetch(name, options) 代替 url
     */
    if (API && Object.prototype.hasOwnProperty.call(API, url)) {
      url = API[url]
    }
    if (params) {
      let prefix = url.includes('?') ? '&' : '?'
      url += prefix + querystring.stringify(params)
    }
    options = {
      ...options,
      method: 'GET'
    }
    return this.fetch(url, options)
  }
  /**
   *
   * 封装 post 请求，方便使用
   */
  post(url: string, data: any, options: object): Promise<any> {
    options = {
      ...options,
      method: 'POST',
      body: JSON.stringify(data)
    }
    return this.fetch(url, options)
  }
  /**
   * 预加载 css 样式等资源
   */
  fetchPreload(preload?: Preload): Promise<any> | undefined {
    preload = preload || this.preload
    let keys = Object.keys(preload)

    if (keys.length === 0) {
      return
    }

    let { context } = this
    let list = keys.map(name => {
      if (context.preload[name]) {
        return
      }
      let url = (preload as Preload)[name]

      if (!_.isAbsoluteUrl(url)) {
        if (context.isServer) {
          // 在服务端应请求本地的资源
          url = context.serverPublicPath + url
        } else if (context.isClient) {
          url = context.publicPath + url
        }
      }

      return fetch(url)
        .then(_.toText)
        .then(content => {
          if (url.split('?')[0].indexOf('.css') !== -1) {
            /**
             * 如果是 CSS ，清空回车符
             * 否则同构渲染时 react 计算 checksum 值会不一致
             */
            content = content.replace(/\r+/g, '')
          }
          context.preload[name] = content
        })
    })
    return Promise.all(list)
  }

  /**
   * 预加载页面的 js bundle
   */
  prefetch(url: string): any {
    if (!url || typeof url !== 'string') return null
    let matches = (this.matcher as Matcher)(url)
    if (!matches) return null
    return (this.loader as Loader)(matches.controller)
  }

  async init(): Promise<any> {
    if (this.errorDidCatch || this.getComponentFallback) {
      this.proxyHandler = proxyReactCreateElement(this)
    }
    try {
      return await this.initialize()
    } catch (error) {
      if (error === REDIRECT) return null
      if (this.errorDidCatch) this.errorDidCatch(error, 'controller')
      if (this.getViewFallback) {
        return this.getViewFallback() || <EmptyView />
      }
      throw error
    }
  }

  destroy(): void {
    let { meta } = this

    if (this.proxyHandler) {
      this.proxyHandler.detach()
      this.proxyHandler = null
    }

    if (meta.unsubscribeList.length > 0) {
      meta.unsubscribeList.forEach((unsubscribe: any) => unsubscribe())
      meta.unsubscribeList.length = 0
    }
    meta.isDestroyed = true
  }

  async initialize(): Promise<any> {
    let { Model, initialState, actions, context, location, SSR, Loading } = this

    /**
     * 关闭 SSR 后，不执行 componentWillCreate 和 shouldComponentCreate，直接返回 Loading 界面
     * SSR 如果是个方法，则执行并等待它完成
     */
    if (context.isServer) {
      if (typeof this.SSR === 'function') {
        SSR = await this.SSR(location, context)
      }
      if (SSR === false) {
        let View: BaseViewFC | BaseViewClass = Loading || EmptyView
        return <View />
      }
    }

    // 在 init 方法里 bind this，这样 fetch 可以支持继承
    // 如果用 fetch = (url, option = {}) => {} 的写法，它不是原型方法，无法继承
    this.fetch = this.fetch.bind(this)
    this.prefetch = this.prefetch.bind(this)

    // 如果 Model 存在，且 initialState 和 actions 不存在，从 Model 里解构出来
    if (Model && initialState === undefined && actions === undefined) {
      let { initialState: $initialState, ...$actions } = Model
      initialState = this.initialState = $initialState
      actions = this.actions = $actions
    }

    let globalInitialState: State | undefined

    // 服务端把 initialState 吐在 html 里的全局变量 __INITIAL_STATE__ 里
    // @ts-ignore
    if (typeof __INITIAL_STATE__ !== 'undefined') {
      // @ts-ignore
      globalInitialState = __INITIAL_STATE__
      // @ts-ignore
      __INITIAL_STATE__ = undefined
    }

    if (typeof initialState === 'function') {
      initialState = initialState(location, context)
    }

    if (typeof initialState === 'object') {
      //保护性复制初始化状态，避免运行中修改引用导致其他实例初始化数据不对
      initialState = JSON.parse(JSON.stringify(initialState))
    }

    let finalInitialState: State = {
      ...initialState,
      ...globalInitialState,
      location,
      basename: context.basename,
      publicPath: context.publicPath,
      restapi: context.restapi
    }

    /**
     * 动态获取初始化的 initialState
     */
    if (!globalInitialState && this.getInitialState) {
      finalInitialState = await this.getInitialState(finalInitialState)
    }

    /**
     * 复用了 server side 的 state 数据之后执行
     */
    if (globalInitialState && this.stateDidReuse) {
      this.stateDidReuse(finalInitialState)
    }

    /**
     * 动态获取最终的 actions
     */
    if (this.getFinalActions) {
      actions = this.getFinalActions(actions)
    }

    /**
     * 创建 store
     */
    let finalActions: Actions = { ...actions, ...shareActions }
    this.store = createStore(finalActions, finalInitialState)
    attachDevToolsIfPossible(this.store)

    // proxy store.actions for handling error
    if (this.errorDidCatch) proxyStoreActions(this)

    /**
     * 将 handle 开头的方法，合并到 this.handlers 中
     */
    this.combineHandlers(this)

    /**
     * 如果存在 globalInitialState
     * 说明服务端渲染了 html 和 intitialState
     * component 已经创建
     * 不需要再调用 shouldComponentCreate 和 componentWillCreate
     */
    if (globalInitialState) {
      this.bindStoreWithView()

      // 如果 preload 未收集到或者加载成功，重新加载一次
      let preloadedKeys:string[] = Object.keys(this.context.preload || {})
      let isPreload:boolean = Object.keys(this.preload || {}).every(key =>
        preloadedKeys.includes(key)
      )

      if (!isPreload) await this.fetchPreload()
      return this.render()
    }

    let promiseList:(Promise<any> | undefined)[] = []

    /**
     * 如果 shouldComponentCreate 返回 false，不创建和渲染 React Component
     * 可以在 shouldComponentCreate 里重定向到别的 Url
     */
    if (this.shouldComponentCreate) {
      let shouldCreate = await this.shouldComponentCreate()
      if (shouldCreate === false) {
        return null
      }
    }

    // 在 React Component 创建前调用，可以发 ajax 请求获取数据
    if (this.componentWillCreate) {
      promiseList.push(this.componentWillCreate())
    }

    /**
     * 获取预加载的资源
     */
    if (this.preload) {
      promiseList.push(this.fetchPreload())
    }

    if (promiseList.length) {
      await Promise.all(promiseList)
    }

    this.bindStoreWithView()
    return this.render()
  }
  bindStoreWithView() {
    let { context, store, history, meta } = this

    // bind store with view in client
    if (!context.isClient || meta.isDestroyed) {
      return
    }

    if (store) {
      let unsubscribe:object = store.subscribe((data: any) => {
        (this.refreshView as UdfFuncType)()
        if (this.stateDidChange) {
          this.stateDidChange(data)
        }
      })
      meta.unsubscribeList.push(unsubscribe)
    }

    // 判断是否缓存
    {
      let unlisten:object = history.listenBefore((location: Location) => {
        if (!this.KeepAliveOnPush) return
        if (location.action === 'PUSH') {
          (this.saveToCache as UdfFuncType)()
        } else {
          this.removeFromCache()
        }
      })
      meta.unsubscribeList.push(unlisten)
    }

    // 监听路由跳转
    if (this.pageWillLeave) {
      let unlisten:object = history.listenBefore(this.pageWillLeave.bind(this))
      meta.unsubscribeList.push(unlisten)
    }

    // 监听浏览器窗口关闭
    if (this.windowWillUnload) {
      let unlisten:object = history.listenBeforeUnload(
        this.windowWillUnload.bind(this)
      )
      meta.unsubscribeList.push(unlisten)
    }
  }

  restore(location: Location, context: Context) {
    let { meta, store } = this
    let { __PAGE_DID_BACK__ } = store.actions

    if (this.proxyHandler) {
      // detach first, and re-attach
      this.proxyHandler.detach()
      this.proxyHandler.attach()
    }

    meta.isDestroyed = false
    __PAGE_DID_BACK__(location)

    if (this.pageDidBack) {
      this.pageDidBack(location, context)
    }

    this.bindStoreWithView()
    return this.render()
  }
  reload() {
    // if not remove controller cache, it will not reload correctly, it will restore instead of reload
    this.removeFromCache()
    this.history.replace(this.location.raw)
  }

  renderView(View = this.View) {
    if (this.context.isServer) return
    if (View && !View.viewId) {
      View.viewId = Date.now()
    }
    let ctrl:Controller = Object.create(this)
    ctrl.View = View
    ctrl.componentDidFirstMount = null
    ctrl.componentDidMount = null
    ctrl.componentWillUnmount = null
    ctrl.meta = {
      ...this.meta,
      id: View.viewId
    }
    if (this.proxyHandler) this.proxyHandler.attach()
    (this.refreshView as UdfFuncType)(<ViewManager controller={ctrl} />)
  }

  render() {
    if (this.proxyHandler) this.proxyHandler.attach()
    return <ViewManager controller={this} />
  }
}

// fixed: webpack rebuild lost original React.createElement
// @ts-ignore
let createElement = React.originalCreateElement || React.createElement

const proxyReactCreateElement:{ (ctrl: Controller): { attach:object, detach:object } } = ctrl => {
  let isAttach:boolean = false
  let attach:object = () => {
    if (isAttach) return
    isAttach = true
    React.createElement = (type: any, ...args: any) => {
      if (typeof type === 'function') {
        if (!type.isErrorBoundary) {
          type = createErrorBoundary(type)
        }
      }
      return createElement(type, ...args)
    }
    // @ts-ignore
    React.originalCreateElement = createElement
  }
  let detach:object = () => {
    isAttach = false
    React.createElement = createElement
  }
  let map:Map<any, any> = new Map()
  let createErrorBoundary = (InputComponent: any) => {
    if (!InputComponent) return InputComponent

    if (InputComponent.ignoreErrors) return InputComponent

    if (map.has(InputComponent)) {
      return map.get(InputComponent)
    }

    const displayName:string = InputComponent.name || InputComponent.displayName

    interface ErrorBoundaryProps {
      forwardedRef?: any
    }
    class ErrorBoundary extends React.Component<ErrorBoundaryProps> {
      static displayName = `ErrorBoundary(${displayName})`
      static isErrorBoundary = true

      state = {
        hasError: false
      }

      static getDerivedStateFromError() {
        return { hasError: true }
      }

      componentDidCatch(error: any) {
        if (typeof ctrl.errorDidCatch === 'function') {
          ctrl.errorDidCatch(error, 'view')
        }
      }
      render() {
        if (this.state.hasError) {
          if (ctrl.getComponentFallback) {
            let result:any = ctrl.getComponentFallback(displayName, InputComponent)
            if (result !== undefined) return result
          }
          return null
        }
        let { forwardedRef, ...rest } = this.props
        return createElement(InputComponent, { ...rest, ref: forwardedRef })
      }
    }

    let Forwarder: {
      isErrorBoundary?: boolean
      [propName: string]: any
    } = React.forwardRef((props, ref) => {
      return createElement(ErrorBoundary, { ...props, forwardedRef: ref })
    })

    Forwarder.isErrorBoundary = true
    map.set(InputComponent, Forwarder)

    return Forwarder
  }

  return { attach, detach }
}

const proxyStoreActions:{ (ctrl: Controller):any } = ctrl => {
  let actions:Actions = {}

  for (let key in ctrl.store.actions) {
    let action:{ (...args:any):State } = ctrl.store.actions[key]
    actions[key] = (payload: Payload) => {
      try {
        return action(payload)
      } catch (error) {
        (ctrl.errorDidCatch as { (error: Error, str: string):void})(error, 'model')
        throw error
      }
    }
  }

  ctrl.store.actions = actions
}
