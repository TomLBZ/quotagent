import { randomUUID, createHash } from 'node:crypto'

const now=()=>new Date().toISOString()
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const copy=value=>structuredClone(value)
const text=(value,max=200)=>String(value??'').trim().slice(0,max)
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const defaultRoles=()=>[
  {id:'director',label:'Director',limit:null,canWrite:true,canManage:true,canReviewPolicy:true},
  {id:'lead',label:'Team lead',limit:null,canWrite:true,canManage:false,canReviewPolicy:true},
  {id:'buyer',label:'Team member',limit:0,canWrite:true,canManage:false,canReviewPolicy:false},
  {id:'observer',label:'Observer',limit:0,canWrite:false,canManage:false,canReviewPolicy:false},
]
const defaultPolicy=()=>({currency:'USD',roles:defaultRoles(),timeoutMinutes:1440,timeoutPolicy:'remind'})

export function createTeams({store,accounts,notifications=()=>null,procurement=()=>null,actions=()=>null}) {
  const locks=new Map();let disposed=false
  const serial=(id,work)=>{
    if(disposed)return Promise.reject(new Error('Teams is reloading. Please retry.'))
    const task=(locks.get(id)||Promise.resolve()).catch(()=>{}).then(work);locks.set(id,task)
    task.finally(()=>{if(locks.get(id)===task)locks.delete(id)}).catch(()=>{});return task
  }
  const actor=user=>{
    const person=accounts.get(user?.actorId||user?.id)
    if(!person||person.disabled)fail('Sign in to your business account.',401)
    if(!['contractor','supplier'].includes(person.role))fail('Teams belong to contractor or supplier workspaces.',403)
    return person
  }
  const rawTeam=ownerId=>{
    const owner=accounts.get(ownerId)
    if(!owner||owner.disabled||!['contractor','supplier'].includes(owner.role))fail('This party workspace is unavailable.',404)
    const saved=store.get(ownerId,'party-teams',ownerId+':'+owner.role)
    return saved?{...saved,id:ownerId}:{id:ownerId,ownerId,name:owner.company||owner.name,side:owner.role,revision:0,policyRevision:0,policy:defaultPolicy(),members:[{accountId:ownerId,roleId:'director',active:true,title:'Workspace owner',reportsTo:null,acceptedAt:owner.createdAt}],createdAt:owner.createdAt||now()}
  }
  const membership=(user,ownerId)=>{
    const person=actor(user),team=rawTeam(ownerId),member=team.members.find(row=>row.accountId===person.id&&row.active)
    if(person.role!==team.side||!member)fail('You are not an active member of this party workspace.',403)
    const role=team.policy.roles.find(row=>row.id===member.roleId)
    if(!role)fail('Your team role is no longer available. Ask the workspace owner to assign one.',403)
    return {person,team,member,role}
  }
  const scope=(user,ownerId)=>{
    const person=actor(user),selected=ownerId||user.workspaceOwnerId||store.get(person.id,'team-selections','current')?.ownerId||person.id
    return membership(person,selected)
  }
  const withScope=(user,ownerId)=>{const {person}=membership(user,ownerId);return {...person,workspaceOwnerId:ownerId}}
  const resolveUser=(user,operation='read')=>{
    const {person,team,member,role}=scope(user)
    if(!['read','snapshot'].includes(operation)&&(!role.canWrite||!accounts.can(person,'workspace:write')))fail('Your team role has read-only business access.',403)
    const owner=accounts.get(team.ownerId)
    return {...owner,actorId:person.id,actorName:person.name,workspaceOwnerId:team.ownerId,teamRole:member.roleId,permissions:person.permissions||[]}
  }
  const canManage=state=>{if(state.person.id!==state.team.ownerId&&!state.role.canManage)fail('Ask a team manager to change the roster.',403)}
  const put=async(ownerId,collection,record,event,person)=>{
    const value={side:accounts.get(ownerId)?.role,...copy(record),updatedAt:now()}
    await store.put(ownerId,collection,value,{event:`teams/${event}`,actor:`human:${person.id}`});return value
  }
  const saveTeam=(team,event,person)=>put(team.ownerId,'party-teams',{...team,id:team.ownerId+':'+team.side,revision:team.revision+1},event,person)
  const rows=(team,collection)=>store.list(team.id,collection).filter(record=>record.side===team.side)
  const notify=async(accountId,input)=>{
    const recipient=accounts.get(accountId);if(!recipient||recipient.disabled)return
    try{await notifications()?.push(recipient,{...input,link:{view:'team',...input.link}})}
    catch(error){await store.append(accountId,'teams/notification-failed',{sourceId:input.sourceId,error:String(error.message).slice(0,500)},{actor:'system:teams'}).catch(()=>{})}
  }
  const roster=(user,ownerId)=>{
    const {team}=scope(user,ownerId)
    return team.members.map(member=>{
      const person=accounts.get(member.accountId)
      return {...member,name:person?.name||member.accountId,email:person?.email||'',available:!!person&&!person.disabled&&person.role===team.side&&member.active,roleLabel:team.policy.roles.find(role=>role.id===member.roleId)?.label||member.roleId}
    })
  }
  const list=user=>{
    const person=actor(user)
    return accounts.list().filter(account=>account.role===person.role).map(account=>rawTeam(account.id)).filter(team=>team.members.some(member=>member.accountId===person.id&&member.active)).map(team=>({id:team.id,name:team.name,side:team.side,ownerId:team.ownerId}))
  }
  const select=async(user,ownerId)=>{
    const {person,team}=membership(user,ownerId)
    await put(person.id,'team-selections',{id:'current',ownerId},'workspace-selected',person)
    return {ownerId,name:team.name}
  }
  const invite=(user,input)=>{
    const initial=scope(user);canManage(initial)
    return serial(initial.team.id,async()=>{
      const {person,team}=scope(user,initial.team.id);canManage(scope(user,team.id))
      const invitee=accounts.list().find(row=>row.email.toLowerCase()===text(input.email,254).toLowerCase())
      if(!invitee)fail('Ask this colleague to create a Quotagent account first, then invite their email.')
      if(invitee.role!==team.side)fail('Choose a colleague on the same contractor or supplier side.')
      if(team.members.some(row=>row.accountId===invitee.id&&row.active))fail('This colleague is already an active team member.')
      const roleId=text(input.roleId)||'buyer'
      if(!team.policy.roles.some(role=>role.id===roleId))fail('Choose an existing team role.')
      const pending=rows(team,'team-invitations').find(row=>row.toId===invitee.id&&row.status==='pending')
      if(pending)return pending
      const invitation={id:randomUUID(),ownerId:team.id,teamName:team.name,side:team.side,fromId:person.id,fromName:person.name,toId:invitee.id,roleId,status:'pending',createdAt:now()}
      await saveTeam(team,'roster-created',person)
      await put(team.id,'team-invitations',invitation,'invited',person)
      await put(invitee.id,'team-inbox',invitation,'invitation-received',person)
      await notify(invitee.id,{type:'team-invitation',title:'Invitation to '+team.name,body:`${person.name} invited you as ${roleId}. Accept explicitly to share this party workspace.`,sourceId:invitation.id,dedupeKey:'team-invite:'+invitation.id})
      return invitation
    })
  }
  const answerInvite=(user,id,accept)=>{
    const person=actor(user),inbox=store.get(person.id,'team-inbox',id)
    if(!inbox||inbox.toId!==person.id)fail('This invitation is not available.',404)
    return serial(inbox.ownerId,async()=>{
      const invitation=store.get(inbox.ownerId,'team-invitations',id)
      if(!invitation||invitation.status!=='pending')fail('This invitation has already been answered.')
      const team=rawTeam(inbox.ownerId)
      if(invitation.side!==team.side)fail('This workspace changed business perspective. Ask for a new invitation.')
      if(accept&&person.role!==team.side)fail('Your account must use the same business perspective as this team.')
      if(accept){
        if(!team.policy.roles.some(role=>role.id===invitation.roleId))fail('The invited role changed. Ask for a new invitation.')
        const member={accountId:person.id,roleId:invitation.roleId,active:true,title:'',reportsTo:null,acceptedAt:now()}
        team.members=[...team.members.filter(row=>row.accountId!==person.id),member]
        await saveTeam(team,'member-joined',person)
      }
      const next={...invitation,status:accept?'accepted':'declined',answeredAt:now()}
      await put(team.id,'team-invitations',next,'invitation-answered',person)
      await put(person.id,'team-inbox',next,'invitation-answered',person)
      await notify(team.ownerId,{type:'team',title:`${person.name} ${next.status} your invitation`,body:team.name,sourceId:id,dedupeKey:'team-answer:'+id})
      return next
    })
  }
  const updateMember=(user,input)=>{
    const initial=scope(user);canManage(initial)
    return serial(initial.team.id,async()=>{
      const state=scope(user,initial.team.id);canManage(state)
      const member=state.team.members.find(row=>row.accountId===input.accountId)
      if(!member)fail('Choose an existing team member.')
      if(input.active===false&&member.accountId===state.team.ownerId)fail('Keep the workspace owner active.')
      if(input.roleId!==undefined&&!state.team.policy.roles.some(role=>role.id===input.roleId))fail('Choose a defined role.')
      if(input.active!==undefined&&typeof input.active!=='boolean')fail('Active membership must be true or false.')
      if(input.roleId&&member.accountId===state.team.ownerId&&!state.team.policy.roles.find(role=>role.id===input.roleId)?.canManage)fail('The workspace owner must retain a manager role.')
      if(input.reportsTo){
        if(input.reportsTo===member.accountId||!state.team.members.some(row=>row.accountId===input.reportsTo&&row.active))fail('Choose another active colleague as manager.')
        const visited=new Set([member.accountId]);let next=input.reportsTo
        while(next){if(visited.has(next))fail('Reporting lines cannot form a cycle.');visited.add(next);next=state.team.members.find(row=>row.accountId===next)?.reportsTo}
      }
      Object.assign(member,...['roleId','active','reportsTo','title'].filter(key=>input[key]!==undefined).map(key=>({[key]:key==='title'?text(input[key]):input[key]})))
      await saveTeam(state.team,'member-updated',state.person);return member
    })
  }
  const normalizePolicy=input=>{
    const currency=text(input.currency).toUpperCase()
    if(!/^[A-Z]{3}$/.test(currency))fail('Choose the authority currency as a three-letter code.')
    if(!Array.isArray(input.roles)||!input.roles.length||input.roles.length>24)fail('Define between 1 and 24 roles.')
    const seen=new Set(),roles=input.roles.map(role=>{
      const id=text(role.id,40),label=text(role.label,80)
      if(!/^[a-z][a-z0-9-]*$/.test(id)||seen.has(id)||!label)fail('Roles need unique names and readable labels.')
      seen.add(id)
      const limit=role.limit==null?null:role.limit==='unlimited'?'unlimited':Number(role.limit)
      if(limit!==null&&limit!=='unlimited'&&(!Number.isSafeInteger(limit)||limit<0))fail('Authority limits are nonnegative integer cents, unknown or unlimited.')
      return {id,label,limit,canWrite:role.canWrite===true,canManage:role.canManage===true,canReviewPolicy:role.canReviewPolicy===true}
    })
    const timeoutMinutes=Number(input.timeoutMinutes)
    if(!Number.isInteger(timeoutMinutes)||timeoutMinutes<1||timeoutMinutes>525600)fail('Review timeout must be 1 to 525600 minutes.')
    if(!['remind','escalate','expire'].includes(input.timeoutPolicy))fail('Choose remind, escalate or expire. Timeouts never approve an action.')
    return {currency,roles,timeoutMinutes,timeoutPolicy:input.timeoutPolicy}
  }
  const proposePolicy=(user,input)=>{
    const initial=scope(user);canManage(initial)
    return serial(initial.team.id,async()=>{
      const {person,team}=scope(user,initial.team.id),policy=normalizePolicy(input.policy)
      const reviewer=membership(accounts.get(input.reviewerId),team.id)
      if(reviewer.person.id===person.id||!reviewer.role.canReviewPolicy)fail('Nominate another active colleague who can review authority changes.')
      for(const member of team.members)if(member.active&&!policy.roles.some(role=>role.id===member.roleId))fail('A role is still in use. Reassign its members before removing it.')
      if(!policy.roles.find(role=>role.id===team.members.find(member=>member.accountId===team.ownerId).roleId)?.canManage)fail('The owner must retain a manager role.')
      const proposal={id:randomUUID(),ownerId:team.id,proposerId:person.id,reviewerId:reviewer.person.id,status:'pending',baseRevision:team.policyRevision,previous:team.policy,next:policy,fingerprint:hash(policy),reason:text(input.reason,2000),createdAt:now()}
      await saveTeam(team,'roster-created',person)
      await put(team.id,'team-policy-proposals',proposal,'authority-proposed',person)
      await notify(reviewer.person.id,{type:'team-policy',title:'Review team authority changes',body:team.name,sourceId:proposal.id,dedupeKey:'team-policy:'+proposal.id,link:{workspaceId:team.id,policyId:proposal.id}})
      return proposal
    })
  }
  const decidePolicy=(user,id,input)=>{
    const initial=scope(user,input.workspaceId)
    return serial(initial.team.id,async()=>{
      const {person,team,role}=scope(user,initial.team.id),proposal=store.get(team.id,'team-policy-proposals',id)
      if(!proposal||proposal.side!==team.side||proposal.status!=='pending')fail('Choose a pending authority proposal.')
      if(proposal.reviewerId!==person.id||proposal.proposerId===person.id||!role.canReviewPolicy)fail('Only the nominated independent reviewer can decide this policy.',403)
      if(proposal.baseRevision!==team.policyRevision)fail('Authority changed. Ask the proposer to prepare a new review.')
      const next={...proposal,status:input.approved===true?'granted':'rejected',decision:{actorId:person.id,at:now(),reason:text(input.reason,2000)}}
      await put(team.id,'team-policy-proposals',next,'authority-reviewed',person)
      await notify(proposal.proposerId,{type:'team-policy',title:'Authority proposal '+next.status,body:'Review the decision and apply the approved revision when ready.',sourceId:id,dedupeKey:'team-policy-decision:'+id,link:{workspaceId:team.id,policyId:id}})
      return next
    })
  }
  const applyPolicy=(user,id)=>{
    const initial=scope(user);canManage(initial)
    return serial(initial.team.id,async()=>{
      const {person,team}=scope(user,initial.team.id),proposal=store.get(team.id,'team-policy-proposals',id)
      if(!proposal||proposal.side!==team.side||proposal.status!=='granted'||proposal.proposerId!==person.id)fail('Only the proposer can apply a separately approved policy.')
      if(proposal.decision?.actorId===person.id||proposal.decision?.actorId!==proposal.reviewerId)fail('Independent policy review is missing.')
      if(!membership(accounts.get(proposal.reviewerId),team.id).role.canReviewPolicy)fail('The reviewer no longer has authority to approve policy changes.')
      if(proposal.baseRevision!==team.policyRevision||proposal.fingerprint!==hash(proposal.next))fail('This approval no longer matches the current policy. Prepare a fresh proposal.')
      team.policy=copy(proposal.next);team.policyRevision++
      await saveTeam(team,'authority-applied',person)
      await put(team.id,'team-policy-proposals',{...proposal,status:'applied',appliedAt:now(),appliedBy:person.id},'authority-consumed',person)
      return team.policy
    })
  }
  const authority=(user,amount,currency,ownerId)=>{
    const {team,person,member,role}=scope(user,ownerId)
    if(amount!==null&&(!Number.isSafeInteger(amount)||amount<0))fail('Approval amount must be a nonnegative integer number of cents.')
    const bands=team.policy.roles.map(row=>({...row,within:amount!==null&&currency===team.policy.currency&&(row.limit==='unlimited'||typeof row.limit==='number'&&row.limit>=amount)}))
    const value=row=>row.limit==='unlimited'?Infinity:row.limit??-1
    const eligible=bands.filter(row=>row.canWrite&&row.within).sort((a,b)=>value(a)-value(b)||a.id.localeCompare(b.id))
    const within=eligible.some(row=>row.id===member.roleId),next=eligible.find(row=>value(row)>value(role))
    const people=roster(user,team.id).filter(row=>row.available&&eligible.some(role=>role.id===row.roleId))
    return {amount,unit:'cents',currency,policyCurrency:team.policy.currency,policyRevision:team.policyRevision,bands,within,unconfigured:role.limit===null,requiredRole:eligible[0]?.id||null,nextRole:next?.id||null,people,actorId:person.id,reason:amount===null?'Amount is not yet known.':currency!==team.policy.currency?'Authority currency differs; configure an explicit matching policy.':role.limit===null?'Your role has no configured monetary authority.':within?'Within the configured authority.':'This amount needs a colleague with sufficient authority.'}
  }
  const object=(user,reference)=>{
    const kind=text(reference?.kind,30),id=text(reference?.id,160),data=procurement()?.snapshot(user)
    const collection={rfq:'rfqs',quote:'quotes',order:'orders',change:'changes'}[kind]
    const record=collection&&data?.[collection]?.find(row=>row.id===id)
    if(!record)fail('Choose a record available in this party workspace.',404)
    return {kind,id,title:record.title||data.rfqs.find(row=>row.id===record.rfqId)?.title||kind,rfqId:record.rfqId||(kind==='rfq'?id:null),view:{rfq:'rfqs',quote:'quotes',order:'orders',change:'orders'}[kind]}
  }
  const assign=(user,input)=>{
    const initial=scope(user)
    if(!initial.role.canWrite)fail('Your team role cannot assign work.',403)
    const ref=object(user,input.object)
    return serial(initial.team.id,async()=>{
      const {person,team,role}=scope(user,initial.team.id),key=ref.kind+':'+ref.id,old=store.get(team.id,'team-assignments',key)
      const colleague=membership(accounts.get(input.accountId),team.id)
      if(old&&old.assigneeId!==person.id&&old.assignedBy!==person.id&&!role.canManage)fail('Only its assignee, assigner or a team manager can transfer this work.',403)
      if(old&&old.assigneeId!==colleague.person.id&&!text(input.reason))fail('Explain why this work is being transferred.')
      const row={id:key,object:ref,assigneeId:colleague.person.id,assignedBy:person.id,reason:text(input.reason,2000),status:'open',dueAt:input.dueAt||null,createdAt:old?.createdAt||now()}
      if(row.dueAt&&!Number.isFinite(Date.parse(row.dueAt)))fail('Choose a valid due date.')
      await put(team.id,'team-assignments',row,old?'work-transferred':'work-assigned',person)
      await notify(colleague.person.id,{type:'assignment',title:'Assigned: '+ref.title,body:row.reason||'Your teammate assigned this work to you.',sourceId:key,dedupeKey:'assignment:'+key+':'+now(),link:{workspaceId:team.id,object:ref}})
      return row
    })
  }
  const completeAssignment=async(user,id)=>{
    const initial=scope(user)
    return serial(initial.team.id,async()=>{
      const {person,team,role}=scope(user,initial.team.id),row=store.get(team.id,'team-assignments',id)
      if(!row||row.assigneeId!==person.id&&!role.canManage)fail('Only the assignee or a team manager can complete this task.',403)
      return put(team.id,'team-assignments',{...row,status:'completed',completedAt:now(),completedBy:person.id},'work-completed',person)
    })
  }
  const follow=async(user,input)=>{
    const {person,team}=scope(user),ref=object(user,input.object)
    return put(team.id,'team-following',{id:person.id+':'+ref.kind+':'+ref.id,accountId:person.id,object:ref,active:input.active!==false},'following-changed',person)
  }
  const comment=async(user,input)=>{
    const {person,team,role}=scope(user),ref=object(user,input.object),body=text(input.text,12000)
    if(!role.canWrite)fail('Your team role cannot comment.',403)
    if(!body)fail('Write a comment first.')
    const people=roster(user).filter(row=>row.available),tokens=[...body.matchAll(/(?:^|\s)@([^\s,;:]+)/g)].map(match=>match[1].replace(/[.!?]$/,''))
    const mentions=[],unresolved=[]
    for(const token of tokens){const person=people.find(row=>row.email.toLowerCase()===token.toLowerCase()||row.accountId===token);if(person)mentions.push(person.accountId);else unresolved.push(token)}
    const record={id:randomUUID(),object:ref,text:body,authorId:person.id,authorName:person.name,mentions:[...new Set(mentions)],unresolved:[...new Set(unresolved)],createdAt:now()}
    await put(team.id,'team-comments',record,'commented',person)
    const followers=rows(team,'team-following').filter(row=>row.active&&row.object.id===ref.id&&row.object.kind===ref.kind).map(row=>row.accountId)
    const targets=new Set([...mentions,...followers,store.get(team.id,'team-assignments',ref.kind+':'+ref.id)?.assigneeId])
    for(const id of targets)if(id&&id!==person.id&&people.some(row=>row.accountId===id))await notify(id,{type:mentions.includes(id)?'mention':'comment',title:`${person.name}: ${ref.title}`,body,sourceId:record.id,dedupeKey:'team-comment:'+record.id+':'+id,link:{workspaceId:team.id,object:ref}})
    return record
  }
  const state=(user,{commentsLimit=100}={})=>{
    const person=actor(user),workspaces=list(person)
    let current,selectionWarning=''
    try{current=scope(user)}catch{current=scope(person,person.id);selectionWarning='Your previous team is no longer available. Your own workspace is shown.'}
    const {team,member,role}=current,assignments=rows(team,'team-assignments'),comments=rows(team,'team-comments').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),following=rows(team,'team-following').filter(row=>row.accountId===person.id&&row.active)
    const scopeUser={...person,workspaceOwnerId:team.id},data=procurement()?.snapshot(scopeUser)
    const decisions=(actions()?.list(person)||[]).filter(action=>(action.workspaceId||person.id)===team.id&&(action.canNominate||action.canGrant||action.canSign))
    const deadlines=(data?.rfqs||[]).filter(rfq=>rfq.status==='published'&&rfq.deadline).map(rfq=>({kind:'rfq',id:rfq.id,title:rfq.title,view:'rfqs',rfqId:rfq.id,deadline:rfq.deadline})).sort((a,b)=>a.deadline.localeCompare(b.deadline))
    const limit=Math.max(20,Math.min(Number.MAX_SAFE_INTEGER,Number(commentsLimit)||100))
    return {workspace:{...team,members:roster(person,team.id)},workspaces,member,role,selectionWarning,
      invitations:store.list(person.id,'team-inbox').filter(row=>row.side===person.role&&row.status==='pending'),sentInvitations:rows(team,'team-invitations'),
      policyProposals:rows(team,'team-policy-proposals').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),assignments,comments:comments.slice(0,limit),commentPage:{shown:Math.min(limit,comments.length),total:comments.length,hasMore:comments.length>limit},following,
      today:{assignments:assignments.filter(row=>row.assigneeId===person.id&&row.status==='open'),assignedByMe:assignments.filter(row=>row.assignedBy===person.id),mentions:comments.filter(row=>row.mentions.includes(person.id)),following,decisions,deadlines},
      canManage:person.id===team.ownerId||role.canManage}
  }
  const dispose=async()=>{disposed=true;await Promise.allSettled([...locks.values()]);locks.clear()}
  return {scope,withScope,resolveUser,roster,list,select,invite,answerInvite,updateMember,proposePolicy,decidePolicy,applyPolicy,authority,assign,completeAssignment,follow,comment,state,dispose}
}
