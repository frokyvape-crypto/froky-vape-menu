(function(root){
  'use strict';

  const DEFAULT_RULES={
    defaultUnit:5,
    packPatterns:['10병','10개 단위','10개입','10개'],
    mixGroups:[
      {id:'jusco',label:'저스코 · ㅇㄱㄹㅇ',keywords:['저스코']},
      {id:'tropicow',label:'트로피카우 · 아크드립 외',keywords:['트로피카우','아크드립','라드카페','체리엇','텅 플레이버','스피즈']},
      {id:'moko',label:'모코 전체',keywords:['모코리퀴드']},
      {id:'tn-trump',label:'티엔 · 제이씨컴퍼니 트럼프',keywords:['티엔 입호흡','제이씨컴퍼니 트럼프']},
      {id:'smoji',label:'스모지',keywords:['스모지']},
      {id:'goodjuice',label:'굿쥬스',keywords:['굿쥬스']},
      {id:'felix',label:'펠릭스 전체',keywords:['펠릭스']},
      {id:'gaemasisseo',label:'개마시써',keywords:['개마시써']},
      {id:'vapebasket',label:'베이프바스켓 전체',keywords:['베이프바스켓']},
      {id:'masha',label:'마샤 전체',keywords:['마샤']},
      {id:'xhaler-flexx',label:'엑스헤일러 · 플렉스엑스',keywords:['엑스헤일러','플렉스엑스']},
      {id:'sweeden',label:'스위든 전체',keywords:['스위든']},
      {id:'zapjuice',label:'잽쥬스 전체',keywords:['잽쥬스']}
    ]
  };

  let rules=cloneRules(DEFAULT_RULES);

  function cloneRules(source){
    return {
      defaultUnit:Math.max(1,Number(source?.defaultUnit)||5),
      packPatterns:Array.isArray(source?.packPatterns)&&source.packPatterns.length
        ?source.packPatterns.map(String)
        :[...DEFAULT_RULES.packPatterns],
      mixGroups:Array.isArray(source?.mixGroups)
        ?source.mixGroups.map((group,index)=>({
            id:String(group?.id||`group-${index+1}`),
            label:String(group?.label||group?.id||`교차묶음 ${index+1}`),
            productIds:Array.isArray(group?.productIds)?group.productIds.map(String):[],
            keywords:Array.isArray(group?.keywords)?group.keywords.map(String).filter(Boolean):[]
          }))
        :DEFAULT_RULES.mixGroups.map(group=>({...group,productIds:[]}))
    };
  }

  function configure(nextRules){
    rules=cloneRules(nextRules&&typeof nextRules==='object'?nextRules:DEFAULT_RULES);
    return rules;
  }

  function normalized(value){
    return String(value??'').toLowerCase().replace(/\s+/g,'').replace(/[\[\](){}%·._\-]/g,'');
  }

  function hasPackMarker(value){
    const source=normalized(value);
    return rules.packPatterns.some(pattern=>source.includes(normalized(pattern)));
  }

  function isPackOption(product,option){
    if(!product)return false;
    if(hasPackMarker(`${product.name||''} ${option||''}`))return true;
    const options=Array.isArray(product.options)?product.options.filter(Boolean):[];
    if(!options.length)return hasPackMarker(product.flavor||'');
    return hasPackMarker(product.flavor||'')&&options.every(hasPackMarker);
  }

  function mixGroupFor(product){
    if(!product)return null;
    const productId=String(product.id??product.product_no??'');
    const name=normalized(product.name||'');
    return rules.mixGroups.find(group=>
      group.productIds.includes(productId)||group.keywords.some(keyword=>name.includes(normalized(keyword)))
    )||null;
  }

  function ruleFor(product,option){
    if(isPackOption(product,option))return {mode:'pack',step:1,min:1,unit:1,label:'기존 10개 묶음'};
    const group=mixGroupFor(product);
    if(group)return {mode:'mix',step:1,min:1,unit:rules.defaultUnit,groupId:group.id,label:group.label};
    return {mode:'general',step:1,min:1,unit:rules.defaultUnit,label:'일반 상품 전체'};
  }

  function initialQty(product,option){
    return ruleFor(product,option).min;
  }

  function normalizeQty(quantity,rule){
    const value=Math.max(1,Number(quantity)||rule.min);
    return Math.max(rule.min,Math.round(value));
  }

  function adjustQty(quantity,delta,rule){
    const current=normalizeQty(quantity,rule);
    const next=current+(Number(delta)||0)*rule.step;
    return Math.max(rule.min,next);
  }

  function resolveProduct(item,products){
    const found=(Array.isArray(products)?products:[]).find(product=>String(product.id)===String(item.id));
    return found||{id:item.id,name:item.name,flavor:item.flavor||'',options:[item.option].filter(Boolean)};
  }

  function validate(items,products){
    const errors=[];
    const groupTotals=new Map();
    let generalTotal=0;
    let hasFiveUnitItem=false;
    (Array.isArray(items)?items:[]).forEach(item=>{
      const product=resolveProduct(item,products);
      const rule=ruleFor(product,item.option);
      const quantity=Math.max(0,Number(item.qty)||0);
      if(rule.mode==='pack')return;
      hasFiveUnitItem=true;
      if(rule.mode==='mix'){
        const current=groupTotals.get(rule.groupId)||{id:rule.groupId,label:rule.label,total:0,unit:rule.unit};
        current.total+=quantity;
        groupTotals.set(rule.groupId,current);
        return;
      }
      generalTotal+=quantity;
    });
    const general=generalTotal>0?{
      id:'general',label:'일반 상품 전체',total:generalTotal,unit:rules.defaultUnit,
      valid:generalTotal>=rules.defaultUnit,
      needed:Math.max(0,rules.defaultUnit-generalTotal)
    }:null;
    if(general&&!general.valid)errors.push(`일반 상품은 전체 합계 ${general.needed}개를 더 담아주세요.`);
    const groups=[...groupTotals.values()].map(group=>{
      const remainder=group.total%group.unit;
      const valid=group.total>0&&remainder===0;
      const needed=valid?0:group.unit-remainder;
      if(!valid)errors.push(`${group.label} 교차묶음은 ${needed}개를 더 담아주세요.`);
      return {...group,valid,needed};
    });
    return {valid:errors.length===0,errors,groups,general,hasFiveUnitItem};
  }

  function hint(product,option){
    const rule=ruleFor(product,option);
    if(rule.mode==='pack')return '기존 10개 묶음 상품으로 구매됩니다.';
    if(rule.mode==='mix')return `${rule.label} 상품끼리 합계 ${rule.unit}개 단위로 교차 구매할 수 있습니다.`;
    return `일반 상품은 종류와 맛에 관계없이 장바구니 전체 합계 최소 ${rule.unit}개부터 구매할 수 있습니다.`;
  }

  root.PurchaseRules={configure,ruleFor,initialQty,normalizeQty,adjustQty,validate,hint,isPackOption,mixGroupFor};
})(typeof window!=='undefined'?window:globalThis);
