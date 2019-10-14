import { Location, Context, ViewPropsType } from '../../../../src/'
import Controller from '../../../../src/controller'
import React from 'react'

let initialState = {

}

export default class extends Controller<typeof initialState, {}> {
    View = View
    initialState = initialState
    constructor(location: Location, context: Context) {
        super(location, context)
        if (context.isClient) {
            window.controller = this
        } else if (context.isServer) {
            global.controller = this
        }
    }
}


function View({ state }: ViewPropsType<{ state: {} }, {}>) {
    let content = ''
    try {
        content = JSON.stringify(state)
    } catch (e) {
        content = 'error'
    }
    return <div id="basic_state">{content}</div>
}