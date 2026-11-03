(function(root){
  'use strict';

  const DEFAULT_RULES={
    defaultUnit:5,
    packPatterns:['5병','10병','10개 단위','10개입','10개'],
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
      {id:'zapjuice',label:'잽쥬스 전체',keywords:['잽쥬스']},
      {id:'bubblemon-30-33',label:'버블몬 30ml · 33ml',productIds:['62','2857'],keywords:[]},
      {id:'nfuse-cream-of-crop',label:'앤퓨즈 크오크 입호흡 30ml · 폐호흡 60ml',productIds:['1583','1584'],keywords:[]}
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
        :DEFAULT_RULES.mixGroups.map(group=>({
            ...group,
            productIds:Array.isArray(group.productIds)?group.productIds.map(String):[],
            keywords:Array.isArray(group.keywords)?group.keywords.map(String).filter(Boolean):[]
          }))
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

  function packUnitFrom(value){
    const source=normalized(value);
    if(source.includes(normalized('5병')))return 5;
    if(['10병','10개 단위','10개입','10개'].some(pattern=>source.includes(normalized(pattern))))return 10;
    return 0;
  }

  function packUnitFor(product,option){
    if(!product)return 0;
    const direct=[option,product.name,product.flavor].map(packUnitFrom).find(Boolean);
    if(direct)return direct;
    const optionUnits=(Array.isArray(product.options)?product.options:[]).map(packUnitFrom).filter(Boolean);
    return optionUnits.length&&optionUnits.every(unit=>unit===optionUnits[0])?optionUnits[0]:0;
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
    if(isPackOption(product,option)){
      const packUnit=packUnitFor(product,option);
      return {mode:'pack',step:1,min:1,unit:1,packUnit,label:packUnit?`기존 ${packUnit}개 묶음`:'기존 묶음 상품'};
    }
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

  // 결제창 스킨이 inputOption0·1을 ' | '로 합쳐 200자 입력칸 하나에 넣는다.
  const PAY_TEXT_LIMIT=200;
  // 입금액과 바로 대조하도록 합계 금액을 항상 넣는다.
  function payOrderText(lines,totalQty,totalAmount){
    const amount=`${Number(totalAmount).toLocaleString('ko-KR')}원`;
    const plain=[lines.join(' | '),`총 구매수량 ${totalQty}개 · 합계 ${amount}`];
    if(plain.join(' | ').length<=PAY_TEXT_LIMIT)return {fits:true,chunks:plain};
    const short=lines.map(line=>line.replace(/ (액상|전자담배)(?= |$)/g,'').replace(/ \/ /g,'/'));
    const total=`총 ${totalQty}개 ${amount}`;
    if([...short,total].join(' | ').length<=PAY_TEXT_LIMIT)return {fits:true,chunks:[short.join(' | '),total]};
    // 다 못 넣으면 몰래 자르지 않고, 들어가는 상품까지만 넣고 남은 종수를 밝힌다.
    const rest=count=>`외 ${count}종 카톡 전달`;
    const kept=[];
    for(const line of short){
      if([...kept,line,rest(short.length-kept.length-1),total].join(' | ').length>PAY_TEXT_LIMIT)break;
      kept.push(line);
    }
    return {fits:false,chunks:[[...kept,rest(short.length-kept.length)].join(' | '),total]};
  }

  // 옵션 가격이 없거나 0 이하면 기본 가격을 쓴다.
  function unitPrice(product,option){
    const price=Number(product?.optionPrices?.[option]);
    return price>0?price:Number(product?.price||0);
  }

  // 상품·옵션이 삭제됐거나 품절이면 결제할 수 없다.
  function isUnavailable(item,product){
    if(!product||product.soldOut)return true;
    const options=Array.isArray(product.options)?product.options:[];
    if(options.length&&!options.includes(item?.option))return true;
    return Array.isArray(product.soldOutOptions)&&product.soldOutOptions.includes(item?.option);
  }

  function orderTotal(items){
    return items.reduce((sum,item)=>sum+item.price*item.qty,0);
  }

  function orderLines(items){
    const groups=new Map();
    items.forEach(item=>{
      const key=String(item.id??item.name);
      if(!groups.has(key))groups.set(key,[oneLine(item.name)]);
      const option=oneLine(item.option);
      groups.get(key).push([option&&option!=='옵션 없음'?option:null,`${item.qty}개`].filter(Boolean).join(' '));
    });
    return [...groups.values()].map(parts=>parts.filter(Boolean).join(' / '));
  }

  function oneLine(value){
    return String(value??'').replace(/\s+/g,' ').trim();
  }

  function payText(items){
    return payOrderText(orderLines(items),items.reduce((sum,item)=>sum+item.qty,0),orderTotal(items));
  }

  // 결제 상품 단가가 100원이라 수량은 총액÷100이고, 100원 단위가 아니면 결제할 수 없다.
  function payQuantity(total){
    return total>0&&total%100===0?total/100:0;
  }

  function payUrl(baseUrl,items,products){
    const total=orderTotal(items);
    const quantity=payQuantity(total);
    if(!items.length||!quantity||!validate(items,products).valid)return '';
    const url=new URL(baseUrl);
    url.searchParams.set('customOrder','Y');
    url.searchParams.set('buyQty',String(quantity));
    url.searchParams.set('orderAmount',String(total));
    payText(items).chunks.forEach((chunk,index)=>url.searchParams.set(`inputOption${index}`,chunk));
    return url.toString();
  }

  function statusLines(result){
    const lines=[];
    if(result.general)lines.push(result.general.valid
      ?`✅ 일반 상품 전체: 합계 ${result.general.total}개로 최소 주문 충족`
      :`⚠️ 일반 상품 전체: 현재 ${result.general.total}/${result.general.unit}개 · ${result.general.needed}개 더 담아주세요`
    );
    lines.push(...result.groups.map(group=>group.valid
      ?`✅ ${group.label}: 합계 ${group.total}개로 교차묶음 완성`
      :`⚠️ ${group.label}: 현재 ${group.total%group.unit}/${group.unit}개 · ${group.needed}개 더 담아주세요`
    ));
    result.errors.filter(error=>!lines.some(line=>line.includes(error.split(' 교차묶음')[0])||(error.startsWith('일반 상품은')&&line.includes('일반 상품 전체')))).forEach(error=>lines.push(`⚠️ ${error}`));
    if(!lines.length&&result.valid&&result.hasFiveUnitItem)lines.push('✅ 5개 단위 구매 조건을 충족했습니다.');
    return lines;
  }

  function hint(product,option){
    const rule=ruleFor(product,option);
    if(rule.mode==='pack')return rule.packUnit?`기존 ${rule.packUnit}개 묶음 상품으로 구매됩니다.`:'기존 묶음 상품으로 구매됩니다.';
    if(rule.mode==='mix')return `${rule.label} 상품끼리 합계 ${rule.unit}개 단위로 교차 구매할 수 있습니다.`;
    return `일반 상품은 종류와 맛에 관계없이 장바구니 전체 합계 최소 ${rule.unit}개부터 구매할 수 있습니다.`;
  }

  root.PurchaseRules={configure,ruleFor,initialQty,normalizeQty,adjustQty,validate,hint,isPackOption,mixGroupFor,payOrderText,unitPrice,isUnavailable,orderTotal,orderLines,payText,payQuantity,payUrl,statusLines};
})(typeof window!=='undefined'?window:globalThis);
