export const layouts=[
 {id:'focus',name:'Focus',description:'Give your agent the main workspace. Open the assistant when you need it on other pages.',assistantMode:'on-demand'},
 {id:'balanced',name:'Balanced',description:'Start with your agent, then keep the assistant beside your detailed work on a wide screen.',assistantMode:'persistent'},
 {id:'classic',name:'Classic',description:'Start with your records or administration. Keep the assistant beside your work.',assistantMode:'persistent'},
]
export const palettes=[
 {id:'calm',name:'Calm',description:'Fresh green and cool paper.',colors:['#177f72','#f6f8fa','#ffffff'],variables:{'--accent':'#177f72','--accent-dark':'#116657','--accent-light':'#eaf6f1','--canvas':'#f6f8fa','--surface':'#ffffff','--ink':'#182e3a','--muted':'#6c7f88','--line':'#e1e9e9'}},
 {id:'ocean',name:'Ocean',description:'Clear blue with a soft blue-gray canvas.',colors:['#2865ab','#f2f6fc','#ffffff'],variables:{'--accent':'#2865ab','--accent-dark':'#1a4d87','--accent-light':'#e9f1fc','--canvas':'#f2f6fc','--surface':'#ffffff','--ink':'#1d3048','--muted':'#61748c','--line':'#dfe7f2'}},
 {id:'warm',name:'Warm',description:'Deep clay with a warm paper canvas.',colors:['#9b583b','#faf7f2','#fffdfa'],variables:{'--accent':'#9b583b','--accent-dark':'#764027','--accent-light':'#f8ede4','--canvas':'#faf7f2','--surface':'#fffdfa','--ink':'#382f29','--muted':'#7b6f65','--line':'#e9e1d8'}},
]
export const defaults={layout:'focus',palette:'calm',density:'comfortable'}
export function presentation(preferences,role){
 const values={...defaults,...preferences},layout=layouts.find(item=>item.id===values.layout)||layouts[0],palette=palettes.find(item=>item.id===values.palette)||palettes[0]
 return {layout:layout.id,density:values.density,className:`workspace-presentation ws-layout-${layout.id} ws-density-${values.density} ws-palette-${palette.id}`,variables:palette.variables,landingPage:layout.id==='classic'?(role==='admin'?'admin':'workspace'):'agent',assistantMode:layout.assistantMode}
}
