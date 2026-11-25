from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

OUT = 'Trust_Ajo_Pitch_Deck.pptx'
prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BG='F6F4EC'; INK='15352E'; GREEN='206B52'; MINT='DCEBDA'; LIME='C8E66B'
GOLD='D9A640'; MUTED='61746C'; WHITE='FFFFFF'; PALE='EAEFE5'; DARK='102B25'

def rgb(h): return RGBColor.from_string(h)

def shape(s,x,y,w,h,color,kind=MSO_SHAPE.RECTANGLE,line=None):
    a=s.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w), Inches(h))
    a.fill.solid(); a.fill.fore_color.rgb=rgb(color)
    if line: a.line.color.rgb=rgb(line); a.line.width=Pt(1)
    else: a.line.fill.background()
    if kind==MSO_SHAPE.ROUNDED_RECTANGLE:
        try: a.adjustments[0]=.12
        except Exception: pass
    return a

def txt(s,v,x,y,w,h,size=16,color=INK,bold=False,align=PP_ALIGN.LEFT,
        valign=MSO_ANCHOR.TOP,italic=False):
    b=s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    f=b.text_frame; f.clear(); f.word_wrap=True
    f.margin_left=f.margin_right=Inches(0); f.margin_top=f.margin_bottom=Inches(0)
    f.vertical_anchor=valign
    p=f.paragraphs[0]; p.alignment=align; p.space_after=Pt(0); p.space_before=Pt(0)
    r=p.add_run(); r.text=v; r.font.name='Aptos'; r.font.size=Pt(size)
    r.font.bold=bold; r.font.italic=italic; r.font.color.rgb=rgb(color)
    return b

def slide(section,title,dark=False):
    s=prs.slides.add_slide(prs.slide_layouts[6]); s.background.fill.solid()
    s.background.fill.fore_color.rgb=rgb(DARK if dark else BG)
    fg=WHITE if dark else INK; muted='C3D0C8' if dark else MUTED
    txt(s,section.upper(),.72,.38,7,.25,10,LIME if dark else GREEN,True)
    if title: txt(s,title,.72,.78,11.9,.75,29,fg,True)
    txt(s,'TRUST AJO  /  PITCH',.72,7.12,5,.18,8,'A8B8AE' if dark else MUTED,True)
    txt(s,f'{len(prs.slides):02d}',12,7.08,.6,.22,9,'A8B8AE' if dark else MUTED,True,PP_ALIGN.RIGHT)
    return s

# 1 Cover
s=slide('A shared record for rotating savings groups','',True)
shape(s,8.7,0,4.633,7.5,GREEN)
for x,y,d,c in [(9.65,.95,2.55,LIME),(10.8,2.25,1.55,GOLD),(9.35,4.05,2.6,'B6D4AE'),(11.2,4.6,1.1,WHITE)]:
    shape(s,x,y,d,d,c,MSO_SHAPE.OVAL)
txt(s,'TA',9.65,2.87,2.5,.65,34,INK,True,PP_ALIGN.CENTER,MSO_ANCHOR.MIDDLE)
txt(s,'TRUST AJO',.82,.75,4,.3,13,LIME,True)
txt(s,'Make the circle\nclear to everyone.',.82,1.55,7.3,1.85,38,WHITE,True)
txt(s,'Find a group. Agree the terms. Keep the rotation visible.',.86,3.68,7.3,.75,19,'D7E1DA')
shape(s,.86,5.12,2.2,.48,LIME,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'PITCH COMPETITION',.98,5.24,1.96,.16,9,INK,True,PP_ALIGN.CENTER)
txt(s,'Prototype  •  Nigeria',.86,6.15,4,.28,12,'B7C8BE')

# 2 Need + evidence
s=slide('THE OPPORTUNITY','Millions already save together. The coordination is still human.')
txt(s,'Trust Ajo is built around an existing habit, not a new one to teach.',.82,1.58,11.5,.4,18,MUTED)
shape(s,.85,2.32,4.25,3.15,INK,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'11.7m',1.18,2.67,3.4,.85,43,LIME,True)
txt(s,'Nigerian adults used a savings group in 2023.',1.2,3.64,3.35,.9,20,WHITE,True)
txt(s,'Existing behavior. Not Trust Ajo users.',1.2,4.82,3.45,.3,11,'B7C8BE')
items=[('39%','used informal financial services in 2023'),('51%','of adults were aged 18–35')]
for i,(n,b) in enumerate(items):
    y=2.55+i*1.45
    txt(s,n,5.75,y,1.7,.58,29,GREEN,True)
    txt(s,b,7.55,y+.05,4.4,.55,17,INK)
shape(s,5.75,5.5,6.15,.55,MINT,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'Source: EFInA A2F 2023, pp. 15, 48.',5.95,5.66,5.8,.2,10,MUTED)
txt(s,'11.7m is savings-group use; 39% includes other informal services.',.85,6.18,10,.22,9,MUTED,False,italic=True)

# 3 Problem
s=slide('THE FRICTION','When the agreement lives in chats, the group has to do the bookkeeping.')
txt(s,'People still organize around a shared commitment. The details can scatter across messages and personal notes.',.82,1.58,11.4,.65,18,MUTED)
cards=[('01','Terms get buried','Amount, date and payout order are hard to retrieve.'),('02','Clashes show up late','Recurring schedules can conflict after people join.'),('03','Records need reconciling','Members may rely on different notes or confirmations.')]
for i,(n,h,b) in enumerate(cards):
    x=.82+i*4.18
    shape(s,x,2.75,3.78,2.42,WHITE,MSO_SHAPE.ROUNDED_RECTANGLE)
    txt(s,n,x+.25,3.02,.6,.28,11,GREEN,True)
    txt(s,h,x+.25,3.5,3.25,.62,19,INK,True)
    txt(s,b,x+.25,4.28,3.18,.66,13,MUTED)
shape(s,.82,5.64,11.7,.65,MINT,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'Product hypothesis',1.05,5.82,1.7,.22,11,GREEN,True)
txt(s,'A shared record may make coordination clearer. We will measure whether it does.',2.92,5.78,8.9,.3,15,INK)

# 4 Product flow
s=slide('THE PRODUCT','Discover an offer, then run the circle with the same information.')
txt(s,'The group keeps control of its rules. Trust Ajo gives members a common view.',.82,1.55,11.4,.42,18,MUTED)
steps=[('BROWSE','Compare amount, cadence\nand group terms.'),('AGREE','Review dates, capacity\nand payout order.'),('COORDINATE','Track the rotation in\na private group space.')]
for i,(h,b) in enumerate(steps):
    x=.82+i*4.16
    shape(s,x,2.45,3.72,2.46,[MINT,'E7EFD8','F1E7CC'][i],MSO_SHAPE.ROUNDED_RECTANGLE)
    txt(s,f'{i+1:02d}',x+.25,2.72,.5,.26,11,GREEN,True)
    txt(s,h,x+.25,3.2,3,.4,21,INK,True)
    txt(s,b,x+.25,3.83,3.1,.62,15,MUTED)
    if i<2: txt(s,'→',x+3.82,3.35,.35,.42,24,GREEN,True,PP_ALIGN.CENTER)
txt(s,'Schedule-conflict checks  •  accepted payout swaps  •  end-of-rotation choices',.9,5.55,11.4,.42,16,INK,True,PP_ALIGN.CENTER)

# 5 Differentiation
s=slide('THE POSITION','Digital Ajo already exists. Our focus is the path into a well-coordinated group.')
shape(s,.85,2.05,5.25,3.62,WHITE,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'What is already in the category',1.15,2.35,4.65,.35,16,MUTED,True)
for i,line in enumerate(['Digital contribution records','Visible payout order','Group reminders and chat']):
    txt(s,'•',1.18,3.02+i*.58,.25,.28,17,GREEN,True)
    txt(s,line,1.5,3.02+i*.58,4.1,.32,15,INK)
shape(s,6.55,2.05,5.9,3.62,INK,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'What Trust Ajo emphasizes today',6.88,2.35,5.15,.35,16,LIME,True)
for i,line in enumerate(['Browse public offers before joining','Check recurring schedule clashes','Move interested members into private groups']):
    txt(s,'•',6.91,3.02+i*.58,.25,.28,17,LIME,True)
    txt(s,line,7.23,3.02+i*.58,4.7,.42,15,WHITE)
txt(s,'Design distinction to test in a pilot — not a claim that no competitor offers similar tools.',.9,6.07,11.5,.32,12,MUTED,False,PP_ALIGN.CENTER,italic=True)

# 6 Built and validation
s=slide('WHAT EXISTS','An interactive prototype. No live money or measured customer outcomes yet.')
shape(s,.85,2.03,5.2,3.75,MINT,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'BUILT',1.18,2.34,1.25,.3,12,GREEN,True)
for i,line in enumerate(['Offer board, search and interest','Private groups, terms and member chat','Schedule checks, swaps and rotation choices']):
    txt(s,'✓',1.18,3.02+i*.66,.26,.28,16,GREEN,True)
    txt(s,line,1.53,3.02+i*.66,4.05,.44,14,INK)
shape(s,6.48,2.03,5.96,3.75,WHITE,MSO_SHAPE.ROUNDED_RECTANGLE)
txt(s,'NEXT: OPT-IN PILOT',6.82,2.34,3.1,.3,12,GREEN,True)
measures=[('Group setup','Time to fill'),('Operations','Reconciliation minutes'),('Experience','Schedule conflicts, trust pulse')]
for i,(a,b) in enumerate(measures):
    y=3.03+i*.77
    txt(s,a,6.82,y,2.1,.3,14,INK,True)
    txt(s,b,9.15,y,2.75,.3,14,MUTED)
txt(s,'Sample wallet, balances and activity are simulated. Seeded data is not traction.',.9,6.12,11.4,.3,12,MUTED,False,PP_ALIGN.CENTER,italic=True)

# 7 Sustainability and close
s=slide('SUSTAINABILITY','Prove member value. Then price a service that can carry its costs.',True)
txt(s,'1',.92,2.0,.65,.55,27,LIME,True)
txt(s,'Test usage',1.7,2.03,2.1,.34,18,WHITE,True)
txt(s,'Do existing groups adopt the coordination flow?',1.7,2.5,3.4,.52,14,'C3D0C8')
txt(s,'2',5.02,2.0,.65,.55,27,LIME,True)
txt(s,'Test willingness to pay',5.8,2.03,3.0,.34,18,WHITE,True)
txt(s,'Compare a disclosed service fee with member value.',5.8,2.5,3.25,.52,14,'C3D0C8')
txt(s,'3',9.28,2.0,.65,.55,27,LIME,True)
txt(s,'Validate delivery costs',10.05,2.03,2.5,.55,18,WHITE,True)
txt(s,'Partner fees, support and compliance.',10.05,2.7,2.45,.55,14,'C3D0C8')
shape(s,.88,4.05,11.55,.02,GREEN)
txt(s,'OUR ASK',.92,4.45,1.4,.3,11,LIME,True)
txt(s,'Help us recruit pilot groups and learn from payment and compliance partners.',.92,4.95,10.9,.68,22,WHITE,True)
txt(s,'Real-money flows would require an appropriately authorized partner and further legal, security and operational work. The prototype does not hold or transfer funds.',.92,6.02,11.35,.52,11,'C3D0C8')

prs.core_properties.title='Trust Ajo — Pitch Deck'
prs.core_properties.subject='AIESEC 2026 Pitch Competition'
prs.core_properties.author='Trust Ajo'
prs.save(OUT)
print(f'Wrote {OUT} ({len(prs.slides)} slides)')
