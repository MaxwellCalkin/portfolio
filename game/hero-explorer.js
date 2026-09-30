import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * KESTREL / 07 — an original stylised field explorer.
 * Bespoke, sculpted profile meshes rather than an assembly of suit primitives.
 * Metres, feet at y=0, looking down -Z. No external assets or network requests.
 */
export function createHeroExplorer() {
  const root = new THREE.Group(); root.name = 'Kestrel-07-hero-explorer';
  const resources = { geometries: new Set(), materials: new Set() };
  const material = (color, roughness = .66, metalness = .12, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    resources.materials.add(m); return m;
  };
  const M = {
    ivory: material('#e9e4d5', .43, .24), chalk: material('#b6c6c3', .52, .3),
    dark: material('#14242c', .7, .15), rubber: material('#142026', .94, .02),
    fabric: material('#314751', .97, .03), teal: material('#32636a', .64, .17),
    coral: material('#f0744e', .66, .12), deepCoral: material('#b54534', .86, .04),
    metal: material('#73969e', .37, .58), gold: material('#e3b984', .48, .35),
    glass: material('#072a37', .17, .62, { emissive: '#14566a', emissiveIntensity: .30 }),
    light: material('#b2ffed', .28, .24, { emissive: '#71f5dc', emissiveIntensity: 1.4 }),
    orangeLight: material('#ffe3a5', .32, .24, { emissive: '#ff9e62', emissiveIntensity: 1.2 }),
  };
  function add(geo, mat, parent = root, position) {
    resources.geometries.add(geo); const m = new THREE.Mesh(geo, mat);
    if (position) m.position.fromArray(position); m.castShadow = m.receiveShadow = true; parent.add(m); return m;
  }
  function group(name, parent = root, position = [0,0,0]) {
    const g = new THREE.Group(); g.name = name; g.position.fromArray(position); parent.add(g); return g;
  }
  // Sculpted elliptical/superelliptic sections; each profile has its own centre and taper.
  function loft(profiles, mat, parent = root, sides = 12, power = .86) {
    const p = [], ix = [];
    for (const [y,w,d,cx=0,cz=0] of profiles) for (let i=0;i<sides;i++) {
      const a=i*Math.PI*2/sides, s=Math.sin(a), c=Math.cos(a);
      p.push(cx+Math.sign(s)*Math.pow(Math.abs(s),power)*w,y,cz-Math.sign(c)*Math.pow(Math.abs(c),power)*d);
    }
    for(let j=0;j<profiles.length-1;j++)for(let i=0;i<sides;i++) {
      const a=j*sides+i,b=j*sides+(i+1)%sides,c=b+sides,d=a+sides;ix.push(a,c,b,a,d,c);
    }
    for(let i=1;i<sides-1;i++) { ix.push(0,i,i+1);const o=(profiles.length-1)*sides;ix.push(o,o+i+1,o+i); }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();return add(g,mat,parent);
  }
  // Cut-and-bevel pattern pieces, useful for hard-surface armour and inset graphics.
  function plate(points, depth, mat, parent = root, z=0, bevel=.008) {
    const s=new THREE.Shape();points.forEach(([x,y],i)=>i?s.lineTo(x,y):s.moveTo(x,y));s.closePath();
    const g=new THREE.ExtrudeGeometry(s,{depth,bevelEnabled:bevel>0,bevelSegments:1,steps:1,bevelSize:bevel,bevelThickness:bevel,curveSegments:1});g.translate(0,0,-depth/2);
    return add(g,mat,parent,[0,0,z]);
  }
  // A gentle wrap makes armour follow the rib cage instead of reading as flat signs.
  function wrap(m, amount=.7) {
    const p=m.geometry.attributes.position;
    for(let i=0;i<p.count;i++)p.setZ(i,p.getZ(i)+p.getX(i)*p.getX(i)*amount);
    p.needsUpdate=true;m.geometry.computeVertexNormals();return m;
  }
  function stroke(points,radius,mat,parent=root) {
    const g=new THREE.BufferGeometry(); const p=[],ix=[],n=6;
    const pts=points.map(v=>new THREE.Vector3(...v));
    pts.forEach((point,j)=>{
      const tangent=(j===pts.length-1?point.clone().sub(pts[j-1]):pts[j+1].clone().sub(point)).normalize();
      const side=new THREE.Vector3(0,0,1).cross(tangent).normalize();if(side.lengthSq()<.1)side.set(1,0,0);
      const up=tangent.clone().cross(side).normalize();
      for(let i=0;i<n;i++){const a=i*2*Math.PI/n;const v=point.clone().addScaledVector(side,Math.cos(a)*radius).addScaledVector(up,Math.sin(a)*radius);p.push(v.x,v.y,v.z);}
    });
    for(let j=0;j<pts.length-1;j++)for(let i=0;i<n;i++){const a=j*n+i,b=j*n+(i+1)%n,c=b+n,d=a+n;ix.push(a,b,c,a,c,d);}
    g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();return add(g,mat,parent);
  }
  function rivet(x,y,z,mat=M.metal,parent=root,r=.015) {
    const m=add(new THREE.CylinderGeometry(r,r,.012,6),mat,parent,[x,y,z]);m.rotation.x=Math.PI/2;return m;
  }
  function slash(x,y,z,w,h,mat,parent=root,angle=0) {
    const m=plate([[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]],.005,mat,parent,z,.001);m.position.x=x;m.position.y=y;m.rotation.z=angle;return m;
  }
  const body=group('breathing-torso');
  // Anatomical tailoring: pelvis, abdominal taper, ribcage, trapezius and neck.
  loft([[1.12,.24,.15,0,.015],[1.21,.30,.17],[1.33,.275,.15],[1.40,.245,.155]],M.dark,root);
  loft([[1.30,.24,.16],[1.42,.255,.16],[1.59,.31,.185],[1.76,.39,.215],[1.90,.42,.19],[1.99,.23,.145]],M.fabric,body,16);
  loft([[1.97,.115,.10],[2.06,.13,.105],[2.11,.125,.10]],M.rubber,body,12);
  // Rib knit and side panels deliberately follow the body's V taper.
  for(const s of [-1,1]) {
    const side=plate([[s*.245,1.38],[s*.30,1.45],[s*.355,1.74],[s*.285,1.68]],.025,M.dark,body,-.148,.01);side.rotation.y=s*.42;
    for(let i=0;i<4;i++)slash(s*(.243+i*.014),1.41+i*.063,-.173,.078,.013,M.metal,body,s*-.34);
    plate([[s*.035,1.39],[s*.20,1.41],[s*.265,1.60],[s*.045,1.58]],.024,M.teal,body,-.164,.014);
  }
  // Two deliberately non-mirrored jacket/chest plates, wrapped around the pectorals.
  wrap(plate([[-.035,1.62],[-.27,1.58],[-.373,1.78],[-.355,1.93],[-.16,1.98],[-.035,1.83]],.058,M.ivory,body,-.183,.022));
  wrap(plate([[.045,1.64],[.294,1.65],[.405,1.84],[.325,1.96],[.155,1.98],[.035,1.81]],.06,M.ivory,body,-.185,.019));
  plate([[-.346,1.80],[-.292,1.655],[-.196,1.671],[-.245,1.845]],.014,M.coral,body,-.230,.008);
  plate([[.079,1.76],[.268,1.77],[.306,1.862],[.194,1.912],[.084,1.843]],.024,M.chalk,body,-.236,.007);
  slash(.188,1.817,-.255,.127,.018,M.light,body,-.05);
  slash(.204,1.779,-.256,.087,.008,M.dark,body,-.05);
  for(const s of [-1,1])rivet(s*.31,1.876,-.239,M.dark,body,.017);
  // The diagonal utility harness is a continuous tapered tailored strip.
  wrap(plate([[-.284,1.969],[-.209,1.991],[.260,1.443],[.199,1.402]],.031,M.dark,body,-.262,.007));
  wrap(plate([[-.26,1.94],[-.239,1.951],[.214,1.426],[.197,1.42]],.005,M.coral,body,-.283,.001));
  const clasp=group('harness-buckle',body,[.078,1.597,-.29]);clasp.rotation.z=-.69;
  plate([[-.06,-.052],[.06,-.052],[.06,.052],[-.06,.052]],.025,M.metal,clasp,0,.009);
  plate([[-.035,-.025],[.035,-.025],[.035,.025],[-.035,.025]],.029,M.dark,clasp,-.015,.002);
  // High, folded neck scarf: angular collar, warm colour, one original trailing pennant.
  loft([[1.974,.24,.15,0,.015],[2.055,.22,.165,0,.015],[2.092,.159,.137,0,.015]],M.coral,body,12,.72);
  plate([[-.207,2.05],[-.065,1.963],[.155,2.012],[.20,2.069],[.015,2.027]],.027,M.deepCoral,body,-.157,.006);
  plate([[-.222,2.074],[-.057,2.035],[.064,2.064],[-.06,2.098]],.014,M.coral,body,-.149,.004);
  // Strong dorsal shape: swept shoulder yoke surrounding a tapered survey reactor.
  plate([[-.386,1.91],[-.274,1.993],[-.13,1.98],[-.09,1.86],[-.295,1.79]],.065,M.ivory,body,.172,.019);
  plate([[.386,1.91],[.274,1.993],[.13,1.98],[.09,1.86],[.295,1.79]],.065,M.ivory,body,.172,.019);
  loft([[1.43,.145,.04,0,.237],[1.55,.23,.08,0,.239],[1.85,.255,.093,0,.233],[1.945,.16,.055,0,.225]],M.dark,body,8,.6);
  plate([[-.19,1.843],[-.14,1.937],[.14,1.937],[.19,1.843],[.141,1.582],[0,1.512],[-.141,1.582]],.066,M.ivory,body,.331,.018);
  plate([[-.138,1.847],[-.084,1.906],[.10,1.906],[.147,1.842],[.104,1.698],[-.103,1.698]],.018,M.teal,body,.374,.005);
  plate([[-.048,1.682],[.048,1.682],[.067,1.802],[0,1.853],[-.067,1.802]],.02,M.dark,body,.399,.005);
  plate([[-.019,1.708],[.019,1.708],[.031,1.799],[0,1.825],[-.031,1.799]],.009,M.light,body,.414,.002);
  // Compass/wing crest, dimensional and visible at gameplay distance.
  for(const s of [-1,1]) {
    plate([[s*.038,1.827],[s*.071,1.86],[s*.12,1.845],[s*.07,1.788]],.008,M.gold,body,.410,.002);
    for(let i=0;i<3;i++)slash(s*(.161-i*.011),1.665-i*.026,.377,.034,.012,i===1?M.light:M.dark,body,s*.22);
    rivet(s*.145,1.866,.385,M.dark,body,.012);
  }
  // Side equipment, secured rather than a rectangular oxygen backpack.
  for(const s of [-1,1]) {
    loft([[1.50,.051,.048,s*.254,.24],[1.56,.06,.061,s*.256,.237],[1.81,.055,.061,s*.263,.232],[1.85,.034,.038,s*.252,.224]],s<0?M.coral:M.chalk,body,8,.65);
    stroke([[s*.30,1.84,.17],[s*.342,1.78,.215],[s*.285,1.53,.237]],.018,M.dark,body);
    stroke([[s*.295,1.83,.185],[s*.326,1.779,.231],[s*.275,1.54,.25]],.008,M.metal,body);
  }
  // Utility belt segmented around the waist; no oversized square waist block.
  loft([[1.282,.282,.174],[1.357,.283,.17]],M.dark,root,12,.75);
  plate([[-.058,1.286],[.065,1.286],[.082,1.342],[.051,1.37],[-.065,1.36],[-.08,1.32]],.036,M.metal,root,-.184,.007);
  plate([[-.027,1.304],[.033,1.304],[.043,1.338],[-.027,1.342]],.012,M.coral,root,-.209,.003);
  for(const s of [-1,1]) {
    plate([[s*.137,1.277],[s*.246,1.287],[s*.258,1.374],[s*.163,1.383]],.07,s<0?M.teal:M.dark,root,-.138,.012);
    slash(s*.199,1.354,-.183,.046,.014,M.gold,root,s*.08);
  }
  // Split coat: triangulated, folded cloth with tailored piping and warm lining.
  const clothMaterials=new Map();
  const doubleSided=mat=>{if(!clothMaterials.has(mat)){const copy=mat.clone();copy.side=THREE.DoubleSide;resources.materials.add(copy);clothMaterials.set(mat,copy);}return clothMaterials.get(mat);};
  function cloth(rows, mat, parent, lining=M.teal) {
    const positions=[],indices=[];
    rows.forEach(([y,left,right,z,fold=0])=>positions.push(left,y,z,(left+right)/2,y-.008,z+fold,right,y,z+.015));
    for(let j=0;j<rows.length-1;j++)for(let c=0;c<2;c++){const a=j*3+c;indices.push(a,a+3,a+4,a,a+4,a+1);}
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setIndex(indices);geo.computeVertexNormals();
    const outer=add(geo,doubleSided(mat),parent);
    add(geo.clone(),doubleSided(lining),parent,[0,0,-.009]);
    return outer;
  }
  const tails=[];
  for(const s of [-1,1]) {
    const tail=group(s<0?'left-split-coattail':'right-split-coattail',root,[s*.025,1.32,.12]);tails.push(tail);
    const rows=s<0?[[0,-.246,-.035,.035,.07],[-.24,-.326,-.041,.122,.066],[-.49,-.378,-.076,.233,.067],[-.72,-.342,-.164,.288,.06]]:[[0,.035,.246,.035,.07],[-.22,.041,.320,.111,.066],[-.43,.062,.35,.207,.058],[-.66,.141,.328,.245,.055]];
    cloth(rows,M.ivory,tail,M.teal);
    stroke(rows.map(r=>[s<0?r[1]:r[2],r[0],r[3]+.021]),.012,M.coral,tail);
    const last=rows.at(-1);stroke([[last[1],last[0],last[3]+.014],[(last[1]+last[2])/2,last[0]-.008,last[3]+last[4]+.012],[last[2],last[0],last[3]+.03]],.011,M.dark,tail);
    if(s<0){cloth([[-.30,-.327,-.270,.161,.01],[-.49,-.363,-.303,.246,.01],[-.64,-.345,-.292,.278,.01]],M.coral,tail,M.deepCoral);}
  }
  const scarf=group('wind-swept-scarf',body,[-.155,2.033,.111]);
  cloth([[0,-.028,.066,.027,.013],[-.12,-.136,.052,.118,.021],[-.33,-.259,-.084,.219,.028],[-.55,-.342,-.202,.315,.019],[-.70,-.37,-.251,.34,.009]],M.coral,scarf,M.deepCoral);
  stroke([[-.028,0,.041],[-.136,-.12,.132],[-.259,-.33,.233],[-.342,-.55,.329],[-.37,-.70,.354]],.007,M.gold,scarf);
  // Narrow aerodynamic helmet, sculpted brow, faceted jaw and swept rear crown.
  const head=group('angular-flight-helmet',body);
  loft([[2.105,.11,.103,0,-.012],[2.151,.19,.149,0,-.005],[2.235,.217,.186,0,.012],[2.339,.213,.19,0,.023],[2.418,.166,.158,0,.037],[2.454,.072,.083,0,.048]],M.ivory,head,16,.74);
  wrap(plate([[-.182,2.321],[-.205,2.254],[-.138,2.142],[0,2.107],[.138,2.142],[.205,2.254],[.182,2.321],[0,2.349]],.031,M.dark,head,-.160,.011));
  wrap(plate([[-.179,2.306],[-.158,2.247],[-.085,2.215],[0,2.232],[.085,2.215],[.158,2.247],[.179,2.306],[.105,2.326],[-.105,2.326]],.022,M.glass,head,-.190,.006));
  // A divided angled gaze, rather than an astronaut's round fishbowl.
  plate([[-.160,2.288],[-.139,2.270],[-.028,2.271],[-.012,2.286]],.004,M.light,head,-.208,.002);
  plate([[.012,2.286],[.028,2.271],[.139,2.270],[.160,2.288]],.004,M.light,head,-.208,.002);
  plate([[-.016,2.319],[.016,2.319],[.022,2.251],[0,2.229],[-.022,2.251]],.014,M.ivory,head,-.211,.004);
  plate([[-.126,2.194],[-.094,2.146],[0,2.123],[.094,2.146],[.126,2.194],[.068,2.177],[0,2.148],[-.068,2.177]],.035,M.teal,head,-.148,.009);
  slash(0,2.152,-.186,.060,.012,M.dark,head);
  for(const s of [-1,1]) {
    const cheek=plate([[s*.123,2.160],[s*.195,2.190],[s*.216,2.26],[s*.186,2.244]],.035,M.ivory,head,-.103,.007);cheek.rotation.y=s*-.12;
    const ear=group('helmet-comm',head,[s*.211,2.264,.015]);ear.rotation.y=s*Math.PI/2;
    plate([[-.062,-.062],[.05,-.059],[.069,.029],[.028,.074],[-.064,.045]],.03,M.dark,ear,0,.007);
    plate([[-.04,-.035],[.033,-.035],[.046,.024],[.019,.05],[-.044,.03]],.031,s<0?M.coral:M.chalk,ear,.020,.004);
    slash(0,.007,.041,.037,.010,M.light,ear);
    stroke([[s*.181,2.364,-.091],[s*.19,2.364,.066],[s*.128,2.395,.177]],.016,M.dark,head);
  }
  // Crown inset and rear chevron make the third-person view as authored as the face.
  loft([[2.32,.047,.038,0,.182],[2.413,.051,.038,0,.128],[2.456,.035,.061,0,.052]],M.coral,head,8,.64);
  plate([[-.055,2.193],[-.097,2.289],[-.068,2.36],[.048,2.374],[.093,2.290],[.06,2.192]],.020,M.dark,head,.214,.005);
  plate([[.009,2.245],[.029,2.261],[.029,2.333],[.009,2.322]],.008,M.light,head,.231,.002);
  for(let i=0;i<3;i++)slash(.051,2.26+i*.02,.233,.021,.007,M.metal,head,-.12);
  plate([[-.046,2.246],[-.025,2.254],[-.025,2.34],[-.046,2.335]],.008,M.coral,head,.233,.003);
  // Legs: six individually sculpted sections, articulated knees, fitted boots.
  const limbs={}, knees={}, ankles={};
  for(const [side,s] of [['left',-1],['right',1]]) {
    const hip=group(`${side}-hip`,root,[s*.174,1.245,0]);limbs[`${side}Leg`]=hip;
    loft([[-.565,.112,.108,0,-.004],[-.45,.125,.136,s*.010,.006],[-.19,.158,.148,s*.013,.009],[-.02,.146,.14,0,0],[.06,.10,.12,0,0]],M.fabric,hip,12,.84);
    plate([[-.104,-.13],[.098,-.13],[.096,-.35],[.061,-.441],[-.067,-.46],[-.115,-.341]],.023,M.dark,hip,-.133,.010);
    plate([[s*.029,-.112],[s*.148,-.13],[s*.136,-.345],[s*.070,-.417]],.031,s<0?M.chalk:M.ivory,hip,-.117,.012);
    stroke([[s*.139,-.12,-.064],[s*.15,-.31,-.07],[s*.103,-.481,-.069]],.009,s<0?M.coral:M.metal,hip);
    const knee=group(`${side}-knee`,hip,[0,-.56,0]);knees[side]=knee;
    loft([[-.07,.115,.106],[.052,.107,.109]],M.rubber,knee,12);
    plate([[-.09,.041],[.074,.056],[.108,-.025],[.072,-.115],[-.071,-.103],[-.111,-.029]],.045,M.ivory,knee,-.108,.012);
    plate([[-.041,.021],[.04,.030],[.061,-.027],[.026,-.062],[-.027,-.054],[-.06,-.02]],.012,s<0?M.coral:M.teal,knee,-.144,.004);
    loft([[-.465,.066,.083,0,.01],[-.34,.082,.098,0,.018],[-.19,.117,.13,0,.023],[-.07,.103,.107,0,.014]],M.dark,knee,12);
    plate([[-.071,-.419],[.065,-.419],[.091,-.17],[.071,-.101],[-.070,-.106],[-.092,-.196]],.032,M.ivory,knee,-.098,.012);
    plate([[-.024,-.384],[.022,-.384],[.037,-.167],[0,-.132],[-.031,-.172]],.011,M.chalk,knee,-.125,.006);
    slash(s*.055,-.25,-.129,.016,.105,M.coral,knee,-s*.1);
    const boot=group(`${side}-ankle`,knee,[0,-.478,0]);ankles[side]=boot;
    loft([[-.204,.10,.171,0,-.055],[-.155,.116,.186,0,-.069],[-.083,.107,.157,0,-.047],[.03,.078,.09,0,.011],[.095,.083,.094,0,.008]],M.dark,boot,12,.56);
    loft([[-.207,.109,.185,0,-.06],[-.172,.118,.193,0,-.065],[-.148,.111,.184,0,-.06]],M.rubber,boot,12,.53);
    plate([[-.087,-.116],[.092,-.116],[.076,-.043],[.052,.041],[-.06,.039],[-.087,-.046]],.026,M.chalk,boot,-.126,.01);
    // Angular toe cap is a custom widening forward profile, not a box.
    loft([[-.151,.104,.061,0,-.20],[-.112,.096,.064,0,-.19],[-.066,.069,.037,0,-.138]],M.ivory,boot,8,.49);
    for(let i=0;i<2;i++)slash(0,-.02-i*.042,-.149,.102,.016,M.dark,boot);
    slash(0,-.12,.128,.062,.019,M.coral,boot);
    for(const ss of [-1,1])stroke([[ss*.11,-.174,-.17],[ss*.115,-.171,-.06],[ss*.102,-.175,.068]],.009,M.metal,boot);
    // Thigh secured utility holster/pouch with a deliberate slanted edge.
    if(s>0){const pouch=group('right-thigh-survey-kit',hip,[.148,-.178,.005]);pouch.rotation.y=.62;plate([[-.027,.024],[.085,.012],[.093,-.199],[.033,-.242],[-.034,-.205]],.073,M.dark,pouch,-.06,.012);plate([[-.025,.018],[.084,.009],[.081,-.052],[-.03,-.070]],.025,M.coral,pouch,-.108,.007);slash(.03,-.135,-.113,.052,.034,M.metal,pouch);}
  }
  // Rifle: tapered machined receiver, floating barrel shroud and chamfered stock.
  const weapon=group('survey-pulse-rifle',root,[.12,1.675,-.08]);
  const receiver=group('receiver',weapon);receiver.rotation.y=Math.PI/2;
  plate([[-.26,-.063],[.39,-.054],[.48,.011],[.39,.085],[.13,.112],[-.23,.091],[-.31,.03]],.112,M.dark,receiver,0,.014);
  plate([[-.22,.025],[.36,.023],[.40,.054],[.27,.087],[-.19,.079]],.013,M.ivory,receiver,.069,.007);
  plate([[-.2,-.055],[.105,-.051],[.111,.012],[-.202,.011]],.014,M.teal,receiver,.07,.004);
  for(const s of [-1,1]) {
    const rail=group('rifle-side-rail',weapon,[s*.061,.013,-.535]);rail.rotation.y=Math.PI/2;
    plate([[-.23,-.047],[.18,-.043],[.21,.049],[-.15,.068],[-.23,.025]],.02,M.chalk,rail,0,.008);
    for(let i=0;i<3;i++)slash(-.115+i*.083,.017,.017,.036,.024,i===1?M.light:M.dark,rail,-.15);
  }
  // Long axis uses a loft turned through 90 degrees, producing a hexagonal stepped barrel.
  const barrel=loft([[-1.055,.035,.038],[-1.008,.048,.043],[-.925,.041,.038],[-.90,.043,.037],[-.80,.038,.037],[-.51,.047,.044]],M.dark,weapon,8,.65);barrel.rotation.x=Math.PI/2;barrel.position.y=.023;
  const nozzle=loft([[-1.092,.043,.041],[-1.02,.047,.045]],M.metal,weapon,8,.65);nozzle.rotation.x=Math.PI/2;nozzle.position.y=.023;
  const bore=add(new THREE.CylinderGeometry(.025,.025,.004,12),M.light,weapon,[0,.023,-1.096]);bore.rotation.x=Math.PI/2;
  const stock=group('rifle-stock',weapon,[0,0,.185]);stock.rotation.y=Math.PI/2;
  plate([[-.012,-.072],[.211,-.097],[.243,-.064],[.227,.069],[.016,.078],[-.033,.027]],.10,M.dark,stock,0,.012);
  plate([[.096,-.050],[.213,-.065],[.197,.043],[.069,.042]],.116,M.coral,stock,0,.009);
  const grip=group('rifle-grip',weapon,[0,-.07,.015]);grip.rotation.x=-.20;
  loft([[-.155,.039,.047],[-.015,.038,.047],[.018,.043,.04]],M.rubber,grip,8,.68);
  const mag=group('rifle-energy-cell',weapon,[0,-.07,-.255]);mag.rotation.x=-.14;
  loft([[-.156,.045,.072],[-.135,.06,.078],[.014,.055,.062]],M.coral,mag,8,.65);
  const sight=group('reflex-sight',weapon,[0,.114,-.13]);
  plate([[-.046,0],[.046,0],[.042,.074],[.026,.088],[-.026,.088],[-.042,.074]],.041,M.dark,sight,0,.005);
  plate([[-.025,.025],[.025,.025],[.026,.065],[-.025,.065]],.043,M.glass,sight,0,.002);
  slash(0,.047,-.025,.018,.009,M.light,sight);
  const muzzle=group('muzzle-marker',weapon,[0,.023,-1.102]);
  // Two-bone arm chain. Both hands attach to actual weapon grips through analytic IK.
  const arms={};
  for(const [side,s] of [['left',-1],['right',1]]) {
    const shoulder=group(`${side}-shoulder`,body,[s*.43,1.897,.013]);limbs[`${side}Arm`]=shoulder;
    loft([[-.358,.077,.075],[-.27,.101,.11],[-.092,.135,.14],[.027,.116,.124]],s<0?M.coral:M.fabric,shoulder,12);
    const pad=group(`${side}-layered-pauldron`,shoulder,[s*.038,-.055,.008]);
    loft([[-.092,.158,.154,s*.007,-.009],[-.008,s<0?.198:.167,.168,s*.01,0],[.069,.128,.109,0,0]],M.dark,pad,10,.64);
    loft([[-.055,.158,.158,s*.013,-.014],[.020,s<0?.187:.171,.159,s*.007,0],[.099,.099,.079,0,.002]],M.ivory,pad,10,.63);
    if(s<0){const flare=plate([[-.168,-.043],[-.022,-.068],[.127,-.02],[.074,.079],[-.072,.099],[-.187,.023]],.036,M.coral,pad,.113,.008);flare.rotation.z=-.15;}
    for(let i=0;i<2;i++)slash(s*.09,-.02+i*.04,.168,.064,.012,M.light,pad,-s*.35);
    plate([[-.066,-.162],[.069,-.159],[.074,-.249],[.045,-.294],[-.05,-.29],[-.078,-.238]],.023,s<0?M.dark:M.chalk,shoulder,-.105,.007);
    const elbow=group(`${side}-elbow`,shoulder,[0,-.365,0]);
    loft([[-.042,.084,.081],[.03,.078,.079]],M.rubber,elbow,10);
    loft([[-.31,.061,.062],[-.228,.081,.078],[-.081,.098,.096],[-.025,.08,.084]],M.dark,elbow,12);
    plate([[-.049,-.279],[.052,-.272],[.085,-.101],[.062,-.065],[-.063,-.061],[-.088,-.113]],.032,s<0?M.teal:M.ivory,elbow,-.082,.010);
    plate([[-.039,-.134],[.037,-.133],[.048,-.085],[-.039,-.082]],.009,s<0?M.light:M.coral,elbow,-.108,.003);
    loft([[-.309,.07,.067],[-.272,.073,.07]],M.metal,elbow,10,.72);
    const hand=group(`${side}-glove`,elbow,[0,-.338,0]);
    loft([[-.113,.060,.044],[ -.070,.070,.049],[.023,.055,.052]],M.rubber,hand,10,.65);
    plate([[-.047,-.075],[.045,-.075],[.052,-.002],[-.048,.006]],.025,M.chalk,hand,-.045,.007);
    for(let i=0;i<3;i++)slash(-.03+i*.029,-.045,-.065,.014,.031,M.dark,hand);
    loft([[-.105,.028,.034,s*.055,-.018],[-.031,.029,.031,s*.061,-.002]],M.dark,hand,8,.72);
    arms[side]={shoulder,elbow,hand,s};
  }
  // Animation is hierarchical: hips -> knees -> ankles, shoulders -> elbows -> wrists.
  const rig=group('articulated-character-rig');
  for(const child of [...root.children])if(child!==rig)rig.add(child);
  const down=new THREE.Vector3(0,-1,0);
  const target=new THREE.Vector3(),shoulderWorld=new THREE.Vector3(),dir=new THREE.Vector3(),bend=new THREE.Vector3(),elbowPos=new THREE.Vector3();
  const q=new THREE.Quaternion(),invQ=new THREE.Quaternion();
  const soleCorners=[[-.10,-.207,-.247],[.10,-.207,-.247],[-.10,-.207,.120],[.10,-.207,.120]].map(p=>new THREE.Vector3(...p));
  const solePoint=new THREE.Vector3(),rootInverse=new THREE.Matrix4();
  let gait=0,blend=0,recoil=0;
  function solveArm(side,gripPosition) {
    const a=arms[side],l1=.365,l2=.39;
    target.copy(gripPosition).applyMatrix4(weapon.matrixWorld);body.worldToLocal(target);
    shoulderWorld.copy(a.shoulder.position);dir.copy(target).sub(shoulderWorld);let distance=Math.min(l1+l2-.008,Math.max(.18,dir.length()));dir.normalize();
    const along=(l1*l1-l2*l2+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,l1*l1-along*along));
    bend.set(a.s*.60,-.85,.22);bend.addScaledVector(dir,-bend.dot(dir)).normalize();
    elbowPos.copy(shoulderWorld).addScaledVector(dir,along).addScaledVector(bend,height);
    a.shoulder.quaternion.setFromUnitVectors(down,elbowPos.clone().sub(shoulderWorld).normalize());
    q.setFromUnitVectors(down,target.clone().sub(elbowPos).normalize());invQ.copy(a.shoulder.quaternion).invert();a.elbow.quaternion.copy(invQ).multiply(q);
    // A gentle pronated wrist keeps the knuckle plane aligned with the rifle.
    a.hand.rotation.set(.15,side==='left'?-.65:.22,side==='left'?-.12:.08);
  }
  const leftGrip=new THREE.Vector3(-.012,-.063,-.30),rightGrip=new THREE.Vector3(.004,-.123,.001);
  function update(time=0,dt=1/60,{moving=false,aimPitch=0,fire=false,speed=1}={}) {
    const amount=typeof moving==='number'?THREE.MathUtils.clamp(moving,0,1):(moving?1:0);
    blend=THREE.MathUtils.damp(blend,amount,10,dt);gait+=dt*(10.5+Math.min(2,Math.max(0,speed-1))*.9);
    const stride=Math.sin(gait),breath=Math.sin(time*2.1)*.008;
    rig.position.y=0;
    body.position.y=breath+Math.abs(Math.cos(gait*2))*.026*blend;
    body.rotation.z=stride*.022*blend;body.rotation.y=Math.sin(gait)*.024*blend;
    for(const [side,phase] of [['left',0],['right',Math.PI]]) {
      const p=gait+phase,leg=limbs[`${side}Leg`];
      leg.rotation.x=Math.sin(p)*.53*blend;leg.rotation.z=(side==='left'?.025:-.025)*(1-blend*.5);
      knees[side].rotation.x=-Math.max(0,-Math.sin(p))*.91*blend-.025;
      ankles[side].rotation.x=Math.max(0,Math.sin(p))*.19*blend+.025;
    }
    tails.forEach((tail,i)=>{tail.rotation.x=-.07-Math.sin(time*2.7+i)*.045-Math.abs(stride)*.19*blend;tail.rotation.z=Math.sin(gait+i*Math.PI)*.065*blend;});
    scarf.rotation.x=Math.sin(time*2.5)*.08-blend*.14;scarf.rotation.z=.02+Math.sin(time*3.1)*.06+stride*.05*blend;
    recoil=THREE.MathUtils.damp(recoil,fire?1:0,fire?24:13,dt);
    weapon.position.set(.12-Math.max(0,aimPitch)*.045,1.675+Math.max(0,aimPitch)*.04+breath+Math.sin(gait*2)*.012*blend,-.08+recoil*.026);
    weapon.rotation.set(-aimPitch+recoil*.024,Math.sin(gait)*.010*blend,Math.sin(gait)*.012*blend);
    head.rotation.y=-body.rotation.y*.7;head.rotation.x=-aimPitch*.26;
    root.updateMatrixWorld(true);rootInverse.copy(root.matrixWorld).invert();
    let soleHeight=Infinity;
    for(const ankle of Object.values(ankles))for(const corner of soleCorners){solePoint.copy(corner).applyMatrix4(ankle.matrixWorld).applyMatrix4(rootInverse);soleHeight=Math.min(soleHeight,solePoint.y);}
    rig.position.y=-soleHeight;
    root.updateMatrixWorld(true);solveArm('right',rightGrip);solveArm('left',leftGrip);root.updateMatrixWorld(true);
    muzzle.getWorldPosition(root.userData.muzzle);root.worldToLocal(root.userData.muzzle);
  }
  root.userData = { limbs,parts:limbs,weapon,muzzle:new THREE.Vector3(.12,1.698,-1.182),knees,ankles,update,
    height:2.454,modelName:'KESTREL / 07',artDirection:'Original athletic survey operative: angular ceramic armour, tailored split fieldcoat, pulse survey rifle',
    dispose(){root.removeFromParent();for(const g of resources.geometries)g.dispose();for(const m of resources.materials)m.dispose();},
    ...limbs,
  };
  // Batch material-compatible rigid pieces without touching articulation pivots.
  function batchRigidPieces(parent) {
    for(const child of [...parent.children])if(child.isGroup)batchRigidPieces(child);
    const batches=new Map();
    for(const child of parent.children)if(child.isMesh){if(!batches.has(child.material))batches.set(child.material,[]);batches.get(child.material).push(child);}
    for(const [mat,meshes] of batches)if(meshes.length>1){
      const geometries=meshes.map(m=>{m.updateMatrix();const copy=m.geometry.index?m.geometry.toNonIndexed():m.geometry.clone();copy.deleteAttribute('uv');copy.applyMatrix4(m.matrix);return copy;});
      const combined=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());
      if(combined){const m=add(combined,mat,parent);m.name='batched-rigid-details';meshes.forEach(old=>old.removeFromParent());}
    }
  }
  batchRigidPieces(root);
  update(0,0,{moving:false});
  return root;
}
