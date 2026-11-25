from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.dml import MSO_THEME_COLOR

OUT = 'Trust_Ajo_Presentation.pptx'
prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

# Trust Ajo visual system: warm paper, deep forest green, lively lime and restrained gold.
BG = 'F6F4EC'; INK = '15352E'; GREEN = '206B52'; MINT = 'DCEBDA'; LIME = 'C8E66B'
GOLD = 'D9A640'; MUTED = '61746C'; WHITE = 'FFFFFF'; PALE = 'EAEFE5'; RED = 'A54A3D'

def rgb(h): return RGBColor.from_string(h)

def rect(slide, x, y, w, h, color, radius=False, line=None):
    sh = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE,
        Inches(x), Inches(y), Inches(w), Inches(h))
    sh.fill.solid(); sh.fill.fore_color.rgb = rgb(color)
    sh.line.fill.background() if not line else None
    if line:
        sh.line.color.rgb = rgb(line); sh.line.width = Pt(1)
    if radius:
        try: sh.adjustments[0] = 0.12
        except Exception: pass
    return sh

def text(slide, value, x, y, w, h, size=18, color=INK, bold=False, font='Aptos',
         align=PP_ALIGN.LEFT, valign=MSO_ANCHOR.TOP, margin=0, italic=False):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame; tf.clear(); tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(margin)
    tf.margin_top = tf.margin_bottom = Inches(margin)
    tf.vertical_anchor = valign
    p = tf.paragraphs[0]; p.alignment = align
    p.space_after = Pt(0); p.space_before = Pt(0)
    r = p.add_run(); r.text = value
    r.font.name = font; r.font.size = Pt(size); r.font.bold = bold
    r.font.italic = italic; r.font.color.rgb = rgb(color)
    return box

def base(title=None, section=None, dark=False):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    s.background.fill.solid(); s.background.fill.fore_color.rgb = rgb(INK if dark else BG)
    if section:
        text(s, section.upper(), .72, .42, 5.2, .25, 10, LIME if dark else GREEN, True)
    if title:
        text(s, title, .72, .82, 11.9, .72, 30, WHITE if dark else INK, True)
    # footer
    text(s, 'TRUST AJO  /  PRODUCT OVERVIEW', .72, 7.12, 5.5, .18, 8, 'A8B8AE' if dark else MUTED, True)
    text(s, f'{len(prs.slides):02d}', 12.0, 7.08, .6, .25, 9, 'A8B8AE' if dark else MUTED, True, align=PP_ALIGN.RIGHT)
    return s

def bullet(slide, head, body, x, y, w, color=INK, accent=GREEN):
    rect(slide, x, y+.04, .11, .44, accent, True)
    text(slide, head, x+.28, y, w-.28, .32, 16, color, True)
    text(slide, body, x+.28, y+.37, w-.34, .63, 12, MUTED if color==INK else 'C3D0C8')

# 1 — Cover
s=base(dark=True)
rect(s, 8.85, 0, 4.48, 7.5, GREEN)
# circular brand motif
for x,y,d,c in [(9.55,1.1,2.55,LIME),(10.9,2.45,1.7,GOLD),(9.25,4.0,2.8,'B6D4AE'),(11.15,4.65,1.15,WHITE)]:
    sh=s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(d), Inches(d)); sh.fill.solid(); sh.fill.fore_color.rgb=rgb(c); sh.line.fill.background()
text(s,'TA',9.5,3.02,2.4,.7,35,INK,True,align=PP_ALIGN.CENTER,valign=MSO_ANCHOR.MIDDLE)
text(s,'TRUST AJO',.85,.7,4,.4,14,LIME,True)
text(s,'Make the circle\nclear to everyone.',.85,1.65,7.5,1.75,37,WHITE,True)
text(s,'A shared record for rotating savings groups',.9,3.72,6.8,.55,19,'D7E1DA')
rect(s,.9,5.15,2.05,.47,LIME,True)
text(s,'PRODUCT OVERVIEW',1.0,5.25,1.85,.22,10,INK,True,align=PP_ALIGN.CENTER)
text(s,'Prototype concept  •  Nigeria',.9,6.25,4.5,.32,12,'B7C8BE')

# 2 — The everyday problem
s=base('The savings circle already works. The record can be clearer.','THE NEED')
text(s,'Ajo, Esusu and Adashe circles run on trust, shared commitments and a dependable rotation.',.82,1.72,11.3,.58,19,MUTED)
cards=[('01','Terms live in chats','Amount, due date and payout order can be hard to find later.'),('02','Clashes surface late','Members may discover recurring date conflicts after agreeing to join.'),('03','Records need reconciling','Organizers and members may be looking at different notes or message threads.')]
for i,(n,h,b) in enumerate(cards):
    x=.82+i*4.15
    rect(s,x,2.65,3.75,2.45,WHITE,True)
    text(s,n,x+.25,2.9,.6,.35,12,GREEN,True)
    text(s,h,x+.25,3.45,3.18,.55,19,INK,True)
    text(s,b,x+.25,4.13,3.15,.73,13,MUTED)
rect(s,.82,5.55,11.7,.72,MINT,True)
text(s,'Product hypothesis',1.08,5.74,1.75,.28,12,GREEN,True)
text(s,'One member-visible record may reduce uncertainty while the group keeps control of its rules.',2.95,5.72,9.1,.35,15,INK)

# 3 — What it is
s=base('Trust Ajo makes the group agreement visible.','THE PRODUCT')
text(s,'A lightweight coordination layer for informal rotating savings circles.',.82,1.68,11,.45,20,MUTED)
steps=[('AGREE','Contribution amount\nFrequency and first due date'),('INVITE','Capacity and payout order\nInvitees review terms'),('TRACK','Shared contribution record\nRotation advances by cycle')]
for i,(h,b) in enumerate(steps):
    x=.85+i*4.2
    rect(s,x,2.65,3.6,2.15,[MINT,'E7EFD8','F1E7CC'][i],True)
    text(s,f'{i+1:02d}',x+.26,2.9,.55,.32,12,GREEN,True)
    text(s,h,x+.26,3.4,3,.45,21,INK,True)
    text(s,b,x+.26,4.03,3.05,.65,14,MUTED)
    if i<2:
        text(s,'→',x+3.73,3.4,.38,.48,23,GREEN,True,align=PP_ALIGN.CENTER)
text(s,'The circle sets the rules. Trust Ajo helps everyone see the same version.',.9,5.55,11,.5,17,INK,True,align=PP_ALIGN.CENTER)

# 4 — Product flow
s=base('From invite to an up-to-date rotation','HOW IT WORKS')
flow=[('1','Set up a circle','Choose weekly or monthly cadence, amount, first due date and capacity.'),('2','Review before joining','Invitee sees the terms and payout order; the app checks capacity and date clashes.'),('3','Record contributions','Duplicate cycle entries are rejected; contributions open on the agreed due date.'),('4','Advance the turn','Once every member has contributed, the recorded rotation moves forward.')]
for i,(n,h,b) in enumerate(flow):
    y=1.75+i*1.18
    sh=s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(.9), Inches(y), Inches(.52), Inches(.52)); sh.fill.solid(); sh.fill.fore_color.rgb=rgb(GREEN); sh.line.fill.background()
    text(s,n,.9,y+.08,.52,.3,13,WHITE,True,align=PP_ALIGN.CENTER)
    if i<3: rect(s,1.14,y+.57,.04,.64,'C5D8CA')
    text(s,h,1.75,y-.01,2.7,.34,16,INK,True)
    text(s,b,4.55,y-.01,7.45,.6,13,MUTED)
rect(s,.9,6.45,11.6,.4,PALE,True)
text(s,'Invite confirmation checks schedule conflicts again, so the final join uses current information.',1.08,6.54,11.2,.2,11,GREEN,True,align=PP_ALIGN.CENTER)

# 5 — Value by stakeholder
s=base('A clearer view for members and organizers','WHO IT SERVES')
rect(s,.85,1.82,5.55,3.95,WHITE,True)
rect(s,6.92,1.82,5.55,3.95,INK,True)
text(s,'MEMBERS',1.2,2.18,3,.35,12,GREEN,True)
bullet(s,'Know the commitment','Amount, cadence and due date are visible before joining.',1.2,2.85,4.65)
bullet(s,'See the agreed turn','Payout order and cycle progress are in one shared view.',1.2,4.1,4.65)
text(s,'ORGANIZERS',7.28,2.18,3,.35,12,LIME,True)
bullet(s,'Coordinate with less guesswork','A shared schedule and capacity make the circle easier to explain.',7.28,2.85,4.65,WHITE,LIME)
bullet(s,'Keep the group in charge','Invite code can be rotated; the organizer still sets group rules.',7.28,4.1,4.65,WHITE,LIME)
text(s,'Designed for informal groups, traders and makers who already save together.',1.0,6.15,11.3,.4,15,MUTED,False,align=PP_ALIGN.CENTER)

# 6 — Trust boundary
s=base('Trust comes from being clear about what the record means','TRUST & SAFETY')
rect(s,.85,1.85,5.55,4.45,MINT,True)
rect(s,6.92,1.85,5.55,4.45,'F1E7CC',True)
text(s,'WHAT THE PROTOTYPE DOES',1.2,2.18,4.9,.35,12,GREEN,True)
bullet(s,'Keeps a visible circle record','Terms, contribution entries and payout order.',1.2,2.8,4.7)
bullet(s,'Checks group logistics','Capacity, recurring due-date clashes and duplicate entries.',1.2,4.02,4.7)
text(s,'WHAT IT DOES NOT DO',7.28,2.18,4.8,.35,12,RED,True)
bullet(s,'Hold or transfer pooled money','Payouts remain manual and outside the app.',7.28,2.8,4.7,INK,RED)
bullet(s,'Prove income or creditworthiness','Passport figures are synthetic; entries are not independent proof of payment.',7.28,4.02,4.7,INK,RED)
text(s,'Optional Flutterwave checkout is sandbox-only. Demo ledger entries do not move money.',1.0,6.55,11.4,.28,12,MUTED,True,align=PP_ALIGN.CENTER)

# 7 — Pilot hypothesis and metrics
s=base('Test the promise with real circles before scaling','PILOT PLAN')
text(s,'Run a small, opt-in pilot with existing groups and compare the experience with their current process.',.85,1.65,11.6,.62,18,MUTED)
metrics=[('MISSED CONTRIBUTIONS','Count per cycle'),('SCHEDULE CLASHES','Avoidable conflicts'),('RECONCILIATION TIME','Minutes per cycle'),('MEMBER TRUST','Short before/after pulse')]
for i,(h,b) in enumerate(metrics):
    x=.85+(i%2)*6.05; y=2.65+(i//2)*1.48
    rect(s,x,y,5.55,1.08,WHITE,True)
    text(s,h,x+.25,y+.2,4.95,.28,12,GREEN,True)
    text(s,b,x+.25,y+.57,4.95,.28,14,INK)
rect(s,.85,5.95,11.75,.62,INK,True)
text(s,'No impact claim yet: this is a hypothesis to measure, not a proven outcome.',1.12,6.12,11.2,.28,14,WHITE,True,align=PP_ALIGN.CENTER)

# 8 — Product maturity
s=base('A prototype today. A measured product path next.','WHAT COMES NEXT')
milestones=[('01  LISTEN','Validate language and pain points with members and organizers.'),('02  PROTECT','Add consent, correction, dispute and safe group-exit flows.'),('03  HARDEN','Build user-scoped storage, access controls and payment reconciliation.'),('04  INCLUDE','Test small screens, low bandwidth, accessibility and shared-phone use.')]
for i,(h,b) in enumerate(milestones):
    x=.85+i*3.05
    rect(s,x,2.1,2.68,2.7,[MINT,'E7EFD8','F1E7CC','E4EAE7'][i],True)
    text(s,h,x+.22,2.42,2.25,.36,13,GREEN,True)
    text(s,b,x+.22,3.05,2.2,1.15,13,INK)
text(s,'Real member data and real-money payouts require further security, privacy and operational review.',.95,5.6,11.5,.6,15,MUTED,True,align=PP_ALIGN.CENTER)

# 9 — Close
s=base(dark=True)
rect(s,0,5.72,13.333,1.78,GREEN)
text(s,'TRUST AJO',.9,.8,4,.4,14,LIME,True)
text(s,'Make the circle\nclear to everyone.',.9,1.65,8.8,1.8,38,WHITE,True)
text(s,'A shared record. Group-set rules. A pilot grounded in real member feedback.',.95,4.2,10.8,.58,18,'D7E1DA')
text(s,'Trust Ajo is a prototype for coordinating rotating savings circles.',.95,6.2,11.2,.42,13,WHITE)
text(s,'trustajo',11.5,.88,1.0,.3,11,LIME,True,align=PP_ALIGN.RIGHT)

prs.core_properties.title = 'Trust Ajo | Product Overview'
prs.core_properties.subject = 'Product concept, prototype scope, trust boundaries and pilot plan'
prs.core_properties.author = 'Trust Ajo'
prs.core_properties.keywords = 'Trust Ajo, Ajo, Esusu, Adashe, savings circles'
prs.save(OUT)
print(f'Created {OUT} with {len(prs.slides)} slides')
