/** Authorized compact row projection; generic WebUI owns queries and preferences. */
export function requestCollection(procurement) {
  return {
    id:'requests',label:'Requests',roles:['contractor','supplier'],defaults:{size:25},
    columns:[
      {key:'title',label:'Title',type:'text'},
      {key:'description',label:'Brief',type:'text'},
      {key:'status',label:'Status',type:'enum'},
      {key:'projectName',label:'Project',type:'text'},
      {key:'sectionName',label:'Section',type:'text'},
      {key:'ownerName',label:'Contractor',type:'text'},
      {key:'deadline',label:'Quote deadline',type:'date'},
      {key:'currency',label:'Currency',type:'enum'},
      {key:'lineCount',label:'Line items',type:'number'},
      {key:'quoteCount',label:'Current offers',type:'number'},
    ],
    load(user) {
      const data=procurement.snapshot(user)
      const offers=new Map()
      for(const quote of data.quotes)if(['submitted','awarded'].includes(quote.status)&&!quote.stale)offers.set(quote.rfqId,(offers.get(quote.rfqId)||0)+1)
      return data.rfqs.map(rfq=>({id:rfq.id,title:rfq.title,description:rfq.description||'',status:rfq.status,
        projectName:rfq.projectName||'',sectionName:rfq.sectionName||'',ownerName:rfq.ownerName||'',
        deadline:rfq.deadline||'',currency:rfq.currency,lineCount:rfq.items?.length||0,quoteCount:offers.get(rfq.id)||0}))
    },
  }
}
