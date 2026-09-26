import assert from 'node:assert/strict'
export async function configureReviewer(ctx, owner, reviewer, currency='USD') {
  const invitation=await ctx.teams.invite(owner,{email:reviewer.email,roleId:'lead'})
  await ctx.teams.answerInvite(reviewer,invitation.id,true);await ctx.teams.select(reviewer,owner.id)
  const policy=ctx.teams.state(owner).workspace.policy;policy.currency=currency
  policy.roles=policy.roles.map(role=>({...role,limit:role.id==='lead'?1000000:0}))
  const proposal=await ctx.teams.proposePolicy(owner,{policy,reviewerId:reviewer.id,reason:'Explicit fixture authority reviewed by a different colleague'})
  await ctx.teams.decidePolicy(reviewer,proposal.id,{approved:true});await ctx.teams.applyPolicy(owner,proposal.id)
}
export async function grantAndSign(ctx, owner, reviewer, proposal) {
  await ctx.actions.nominate(owner,proposal.proposal.id,{reviewerId:reviewer.id})
  await ctx.actions.grant(reviewer,proposal.proposal.id,{confirmed:true,reason:'Checked source scope and exact amount'})
  const result=await ctx.actions.approve(owner,proposal.proposal.id,{confirmed:true})
  assert.equal(result.status,'succeeded',result.error);return result.result
}
