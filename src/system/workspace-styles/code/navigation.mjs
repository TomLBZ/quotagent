const groups=[
 {id:'quotation',label:'Quotation work',icon:'file',ids:['workspace','rfqs','quotes','responses','orders','messages','commercial','team']},
 {id:'management',label:'Manage application',icon:'shield',ids:['admin','plugins','operations']},
 {id:'sources',label:'Sources & connections',icon:'mail',ids:['ingestion','mail','telegram','connections','exchange','attachments','evidence','retention']},
 {id:'personalize',label:'Personalize',icon:'puzzle',ids:['extensions','installed-tools','workspace-style','ai-usage','plugin-settings']},
]
export function groupNavigation(items){
 const byId=new Map(items.map(item=>[item.id,item])),take=ids=>ids.map(id=>byId.get(id)).filter(Boolean)
 const primary=take(['agent','workroom','approvals']),utilities=take(['notifications','help','settings']),sections=groups.map(group=>({...group,label:group.id==='management'&&!byId.has('admin')&&!byId.has('plugins')?'Workspace records':group.label,items:take(group.ids)})).filter(group=>group.items.length)
 const known=new Set([...primary,...utilities,...sections.flatMap(group=>group.items)].map(item=>item.id)),remaining=items.filter(item=>!known.has(item.id))
 if(remaining.length)sections.push({id:'more',label:'More tools',icon:'grid',items:remaining})
 return{primary,sections,utilities}
}
