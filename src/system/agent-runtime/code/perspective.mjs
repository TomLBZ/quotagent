/** A saved task never changes business perspective when the account changes role. */
export const accountRole=(ctx,user)=>ctx.accounts.get?.(user.id)?.role||ctx.accounts.list?.().find(row=>row.id===user.id)?.role||user.role
export function assertPerspective(ctx,user,run){
 const current=accountRole(ctx,user)
 if(!run.accountRole||run.accountRole!==current)throw Object.assign(new Error(run.accountRole?'This task belongs to a different account perspective. Stop it and start a new task in your current role.':'This older task has no recorded account perspective. Stop it and start a new task; its prior context will not be guessed.'),{status:409,code:'account-role-changed',detail:{reason:'account-role-changed',waitingHelps:false,nextAction:'Stop this saved task and start a new task in your current account role.',recordedRole:run.accountRole||null,currentRole:current}})
 return current
}
