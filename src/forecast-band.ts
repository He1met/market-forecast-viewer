import type{IChartApi,ISeriesApi,ISeriesPrimitive,IPrimitivePaneView,IPrimitivePaneRenderer,SeriesAttachedParameter,Time}from'lightweight-charts';
import type{CanvasRenderingTarget2D}from'fancy-canvas';import{isExperimentForecast,type ChartForecast,type ExperimentChartForecast}from'./chart-model';import{utc}from'./chart';
export type Vertex={time:number;x:number;innerLower:number;innerUpper:number;outerLower:number;outerUpper:number};
export type StageVertex={id:string;startTime:number;endTime:number;lowerPrice:number;upperPrice:number;startX:number;endX:number;lowerY:number;upperY:number};
export class ForecastBand implements ISeriesPrimitive<Time>{
 private update?:()=>void;drawCount=0;rendered:Vertex[]=[];stageRendered:StageVertex[]=[];
 private renderer:IPrimitivePaneRenderer={draw:target=>this.draw(target)};
 private view:IPrimitivePaneView={renderer:()=>this.renderer,zOrder:()=> 'bottom'};
 constructor(private chart:IChartApi,private series:ISeriesApi<'Line'>,private forecast:ChartForecast){}
 attached(p:SeriesAttachedParameter<Time>){this.update=p.requestUpdate;this.update();}
 detached(){this.update=undefined;this.rendered=[];this.stageRendered=[];}
 paneViews(){return[this.view];}
 updateAllViews(){} // Coordinates are evaluated within the actual draw, after scale layout.
 private draw(target:CanvasRenderingTarget2D){const f=this.forecast;if(isExperimentForecast(f)){this.drawExperiment(target,f);return;}const data=[{time:f.anchor_time,inner_lower:f.anchor_price,inner_upper:f.anchor_price,outer_lower:f.anchor_price,outer_upper:f.anchor_price},...f.bands.points];const vertices:Vertex[]=[];
 for(const b of data){const x=this.chart.timeScale().timeToCoordinate(utc(b.time)),il=this.series.priceToCoordinate(b.inner_lower),iu=this.series.priceToCoordinate(b.inner_upper),ol=this.series.priceToCoordinate(b.outer_lower),ou=this.series.priceToCoordinate(b.outer_upper);if(x!==null&&il!==null&&iu!==null&&ol!==null&&ou!==null)vertices.push({time:b.time,x,innerLower:il,innerUpper:iu,outerLower:ol,outerUpper:ou});}
 this.rendered=vertices;this.drawCount++;
 target.useMediaCoordinateSpace(({context:c,mediaSize})=>{c.save();c.beginPath();c.rect(0,0,mediaSize.width,mediaSize.height);c.clip();const fill=(lower:'innerLower'|'outerLower',upper:'innerUpper'|'outerUpper',color:string)=>{if(vertices.length<2)return;c.beginPath();vertices.forEach((p,i)=>i?c.lineTo(p.x,p[upper]):c.moveTo(p.x,p[upper]));[...vertices].reverse().forEach(p=>c.lineTo(p.x,p[lower]));c.closePath();c.fillStyle=color;c.fill();};fill('outerLower','outerUpper','rgba(116,155,219,0.09)');fill('innerLower','innerUpper','rgba(116,155,219,0.15)');c.strokeStyle='rgba(157,184,222,0.45)';c.lineWidth=1;c.setLineDash([3,5]);
 for(const key of ['outerLower','outerUpper']as const){c.beginPath();vertices.forEach((p,i)=>i?c.lineTo(p.x,p[key]):c.moveTo(p.x,p[key]));c.stroke();}
 const anchor=this.chart.timeScale().timeToCoordinate(utc(f.anchor_time));if(anchor!==null){c.strokeStyle='#d6b47d';c.setLineDash([5,5]);c.beginPath();c.moveTo(anchor,0);c.lineTo(anchor,mediaSize.height);c.stroke();if(anchor>=0&&anchor<mediaSize.width){c.fillStyle='#d8c196';c.font='11px -apple-system, sans-serif';c.fillText('历史 / DEMO 未来',anchor+10,24);}}
 c.setLineDash([]);c.font='10px -apple-system, sans-serif';for(const s of f.stages){const start=this.chart.timeScale().timeToCoordinate(utc(s.start_time)),end=this.chart.timeScale().timeToCoordinate(utc(s.end_time));if(start===null||end===null||end<0||start>mediaSize.width)continue;const left=Math.max(0,start),right=Math.min(mediaSize.width,end);if(right-left>90){c.fillStyle='#8fa8c8';c.textAlign='center';c.fillText(s.name,(left+right)/2,48);}}c.textAlign='left';c.restore();});
 }
 private drawExperiment(target:CanvasRenderingTarget2D,f:ExperimentChartForecast){
  const rectangles:StageVertex[]=[];
  for(const stage of f.stages){
   const startX=this.chart.timeScale().timeToCoordinate(utc(stage.start_time)),endX=this.chart.timeScale().timeToCoordinate(utc(stage.end_time)),lowerY=this.series.priceToCoordinate(stage.lower),upperY=this.series.priceToCoordinate(stage.upper);
   if(startX!==null&&endX!==null&&lowerY!==null&&upperY!==null)rectangles.push({id:stage.id,startTime:stage.start_time,endTime:stage.end_time,lowerPrice:stage.lower,upperPrice:stage.upper,startX,endX,lowerY,upperY});
  }
  this.rendered=[];this.stageRendered=rectangles;this.drawCount++;
  target.useMediaCoordinateSpace(({context:c,mediaSize})=>{
   c.save();c.beginPath();c.rect(0,0,mediaSize.width,mediaSize.height);c.clip();
   // Published M1 ranges are independent constants over each stage. Never join
   // adjacent lower/upper values into slopes, or invent an inner confidence band.
   for(const rect of rectangles){
    if(rect.endX<0||rect.startX>mediaSize.width)continue;
    c.fillStyle='rgba(116,155,219,0.13)';c.fillRect(rect.startX,rect.upperY,rect.endX-rect.startX,rect.lowerY-rect.upperY);
    c.strokeStyle='rgba(157,184,222,0.6)';c.lineWidth=1;c.setLineDash([3,5]);
    c.strokeRect(rect.startX,rect.upperY,rect.endX-rect.startX,rect.lowerY-rect.upperY);
   }
   const anchor=this.chart.timeScale().timeToCoordinate(utc(f.anchor_time));
   if(anchor!==null){c.strokeStyle='#d6b47d';c.setLineDash([5,5]);c.beginPath();c.moveTo(anchor,0);c.lineTo(anchor,mediaSize.height);c.stroke();if(anchor>=0&&anchor<mediaSize.width){c.fillStyle='#d8c196';c.font='11px -apple-system, sans-serif';c.fillText('历史 / 实验预报',anchor+10,24);}}
   c.setLineDash([]);c.font='10px -apple-system, sans-serif';
   for(const stage of f.stages){const rect=rectangles.find(rect=>rect.id===stage.id);if(!rect||rect.endX<0||rect.startX>mediaSize.width)continue;const left=Math.max(0,rect.startX),right=Math.min(mediaSize.width,rect.endX);if(right-left>50){c.fillStyle='#8fa8c8';c.textAlign='center';c.fillText(stage.name,(left+right)/2,48);}}
   c.textAlign='left';c.restore();
  });
 }
}
