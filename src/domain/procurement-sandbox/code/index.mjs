import {createRuntime} from './runtime.mjs'
import {steps} from './scenario.mjs'
export const name='procurement-sandbox'
export const inject=['sandbox']
export function apply(ctx){ctx.effect(()=>ctx.sandbox.registerScenario({id:'quotation-to-order',name:'Quotation to purchase order',roles:['contractor','supplier'],description:'Compare two fictitious lighting offers, inspect the supplier confirmation and independent approval, then practice with an open cabling request.',steps,create:createRuntime}))}
