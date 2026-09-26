import {createHash} from 'node:crypto'
export class AdmissionError extends Error {
 constructor(code,message,details={}){super(message);this.name='AdmissionError';this.code=code;this.status=details.status||429;this.detail={reason:code,nextAction:details.nextAction||'Review the provider controls and retry explicitly.',retryAfterMs:details.retryAfterMs??null,waitingHelps:details.waitingHelps??false,...details}}
}
export const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const decimalUnits=value=>{
 const text=String(value),match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(text)
 if(!match)throw new AdmissionError('invalid-price','Enter a nonnegative price with at most six decimal places.',{status:400})
 const micros=BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0'))
 if(micros>BigInt(Number.MAX_SAFE_INTEGER))throw new AdmissionError('invalid-price','The configured price is too large.',{status:400})
 return micros
}
export const moneyMicros=value=>Number(decimalUnits(value))
export function priceSnapshot(config,connection){
 const known=config.priceKnown===true&&config.priceProvider===connection.provider&&config.priceModel===connection.model&&/^[A-Z]{3}$/.test(config.priceCurrency||'')&&!!String(config.priceSource||'').trim()&&Number.isFinite(Date.parse(config.priceEffectiveAt))
 if(!known)return{status:'unknown',reason:config.priceKnown?'Price provider/model, source or effective date is incomplete or mismatched.':'No explicit price has been configured.',provider:connection.provider,model:connection.model,currency:config.priceCurrency||null}
 return{status:'configured',provider:connection.provider,model:connection.model,currency:config.priceCurrency,inputPerMillionMicros:Number(decimalUnits(config.inputPricePerMillion)),outputPerMillionMicros:Number(decimalUnits(config.outputPricePerMillion)),cachedInputPerMillionMicros:config.cachedPriceKnown?Number(decimalUnits(config.cachedInputPricePerMillion)):null,source:String(config.priceSource).slice(0,1000),effectiveAt:new Date(config.priceEffectiveAt).toISOString()}
}
const price=(tokens,rate)=>Number((BigInt(tokens)*BigInt(rate)+999999n)/1000000n)
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null
export function estimateCost(tokens,tariff,{reserve=false}={}){
 if(tariff.status!=='configured')return{status:'unknown',amountMicros:null,currency:tariff.currency,reason:tariff.reason,tariff}
 const input=count(tokens.input),output=count(tokens.output),cached=count(tokens.cachedInput)
 if(input===null||output===null)return{status:'unknown',amountMicros:null,currency:tariff.currency,reason:'Provider input/output token usage was not fully reported.',tariff}
 if(!reserve&&tariff.cachedInputPerMillionMicros!==null&&cached===null&&tariff.cachedInputPerMillionMicros!==tariff.inputPerMillionMicros)return{status:'unknown',amountMicros:null,currency:tariff.currency,reason:'A separate cache tariff is configured but cached token usage was not reported.',tariff}
 const discounted=reserve?0:Math.min(input,cached||0),inputMicros=price(input-discounted,reserve?Math.max(tariff.inputPerMillionMicros,tariff.cachedInputPerMillionMicros||0):tariff.inputPerMillionMicros)+price(discounted,tariff.cachedInputPerMillionMicros??tariff.inputPerMillionMicros),outputMicros=price(output,tariff.outputPerMillionMicros),amountMicros=inputMicros+outputMicros
 if(!Number.isSafeInteger(amountMicros))throw new AdmissionError('cost-overflow','The configured amount exceeds supported integer accounting.',{status:400})
 return{status:reserve?'reserved-estimate':'priced-estimate',amountMicros,inputMicros,outputMicros,currency:tariff.currency,tariff,note:tariff.cachedInputPerMillionMicros===null?'All input tokens use the configured input rate; cache discounts are not inferred.':'Configured input, cache and output rates applied to reported counts.'}
}
export function estimateRequest(request,maxOutputTokens){return{input:Buffer.byteLength(JSON.stringify(request),'utf8')+256,output:maxOutputTokens,method:'Conservative UTF-8 byte estimate plus request framing allowance; not measured token usage or a universal tokenizer bound'}}
export function checkBudget({amount,used=0,limit=0,kind,resetMs=null}){
 if(!limit)return
 if(amount>limit)throw new AdmissionError(`${kind}-request-too-large`,'This single request exceeds the entire configured budget. Waiting will not make it fit.',{waitingHelps:false,requested:amount,used,limit,nextAction:'Reduce the source/output size or increase your explicit budget.'})
 if(used+amount>limit)throw new AdmissionError(`${kind}-window-exhausted`,'This budget has insufficient room for the next request.',{waitingHelps:resetMs!==null,retryAfterMs:resetMs,requested:amount,used,limit,nextAction:resetMs!==null?'Wait for the recorded budget window to release capacity, reduce the request, or adjust your budget.':'Increase the run budget or start a separate task deliberately; waiting does not reset a run budget.'})
}
export function retryDelay(response,attempt,{baseDelayMs=500,maxDelayMs=30000,wallTime=Date.now(),random=Math.random}={}){
 const retryAfter=response.headers.get('retry-after');let delay=null
 if(retryAfter&&/^\d+(\.\d+)?$/.test(retryAfter))delay=Math.ceil(Number(retryAfter)*1000)
 else if(retryAfter&&Number.isFinite(Date.parse(retryAfter)))delay=Math.max(0,Date.parse(retryAfter)-wallTime)
 if(delay===null)delay=Math.round(baseDelayMs*2**attempt*(1+random()*.25))
 return{delayMs:delay,withinLimit:delay<=maxDelayMs,source:retryAfter?'provider-retry-after':'bounded-exponential-backoff'}
}
