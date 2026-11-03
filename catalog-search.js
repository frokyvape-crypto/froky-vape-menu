(function(root){
  'use strict';

  // 같은 말의 다른 표기는 한 가지로 맞춘다.
  const SPELLINGS=[[/머스캣|머스킷/g,'머스켓'],[/메론/g,'멜론'],[/토바코/g,'타바코']];
  // 묶음의 한 단어로 찾으면 묶음 전체를 찾는다.
  const SYNONYM_GROUPS=[
    ['포도','그레이프','grape'],
    ['자두','플럼','plum'],
    ['복숭아','피치','peach'],
    ['딸기','스트로베리','strawberry'],
    ['수박','워터멜론','watermelon'],
    ['사과','애플','apple'],
    ['파인애플','pineapple'],
    ['자몽','그레이프프룻','그레이프후르츠','grapefruit'],
    ['타바코','연초'],
  ];
  // '애플'은 사과, '그레이프'는 포도지만 파인애플·그레이프프룻은 다른 과일이다.
  const OTHER_FRUIT={
    '애플':/파인애플/g,
    'apple':/pineapple/g,
    '그레이프':/그레이프(프룻|후르츠|푸르트|프루트)/g,
    'grape':/grapefruit/g,
  };

  function normalize(text){
    return SPELLINGS.reduce((value,[from,to])=>value.replace(from,to),String(text??'').toLowerCase().replace(/\s+/g,''));
  }
  function contains(text,term){
    return (OTHER_FRUIT[term]?text.replace(OTHER_FRUIT[term],''):text).includes(term);
  }
  function searchTerms(query){
    const key=normalize(query);
    if(!key)return [];
    const terms=new Set([key]);
    SYNONYM_GROUPS.forEach(group=>{
      if(group.some(term=>contains(key,term)||(key.length>=2&&contains(term,key))))group.forEach(term=>terms.add(term));
    });
    return [...terms];
  }
  function matches(product,query){
    const terms=searchTerms(query);
    if(!terms.length)return true;
    return [product.name,product.flavor,...(Array.isArray(product.options)?product.options:[])].some(value=>{
      const text=normalize(value);
      return terms.some(term=>contains(text,term));
    });
  }

  root.CatalogSearch={matches};
})(typeof window!=='undefined'?window:globalThis);
