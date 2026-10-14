/**
 * The one page `mind web` serves (D-060). Self-contained — no build step,
 * no CDN — so it ships inside the single binary and works offline.
 *
 * Written for a person, not an operator: plain sentences, the thing that needs
 * them first, one obvious button per decision, and every value from the
 * server put on the page with `textContent`, never as HTML.
 */

import { TOKEN_HEADER } from "./token-header.ts";
import { FONT_CSS, FONT_STACK } from "./fonts.ts";
import { TOKENS_CSS } from "./tokens.ts";
import { MARKDOWN_CSS, MARKDOWN_JS } from "./markdown.ts";
import { MASCOT_DARK_DATA_URI, MASCOT_DATA_URI, MASCOT_LIGHT_DATA_URI } from "./mascot.ts";
import { STORAGE_JS } from "./storage.ts";
import { REPORT_LIMITS } from "../decide/report.ts";

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mind</title>
<script>
${STORAGE_JS}
// The saved theme, on the page before it paints (spec §6): no flash of the other one.
try{var savedTheme=webKeep.get(localStorage,"mind-theme");if(savedTheme==="light"||savedTheme==="dark")document.documentElement.setAttribute("data-theme",savedTheme)}catch(e){}
</script>
<link rel="icon" type="image/svg+xml" href="${MASCOT_DATA_URI}">
<style>
${FONT_CSS}
/* D-078: a control console for one agent — the chat in front, what it may do and who answers always in view. */
${TOKENS_CSS}
:root{--foot:28px}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;font-size:16px}
body{margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font:var(--text-body-weight) var(--text-body)/var(--leading-body) ${FONT_STACK}}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) body{background:radial-gradient(1200px 600px at 80% -10%,hsl(var(--primary) / .08),transparent 60%),radial-gradient(900px 500px at -10% 110%,hsl(var(--brand-2) / .06),transparent 60%),hsl(var(--background));background-attachment:fixed}}
:root[data-theme=dark] body{background:radial-gradient(1200px 600px at 80% -10%,hsl(var(--primary) / .08),transparent 60%),radial-gradient(900px 500px at -10% 110%,hsl(var(--brand-2) / .06),transparent 60%),hsl(var(--background));background-attachment:fixed}
code,.mono{font-family:var(--font-mono)}
code{background:hsl(var(--muted));padding:1px 6px;border-radius:6px;font-size:.86em}

/* shell */
.app{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - var(--foot))}
/* D-089: the version, and who this page belongs to, in a thin bar across the bottom of every screen. */
.foot{position:fixed;left:0;right:0;bottom:0;z-index:35;height:var(--foot);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;background:hsl(var(--surface));border-top:1px solid hsl(var(--border));font-size:.75rem;color:hsl(var(--muted-foreground));white-space:nowrap;overflow:hidden}
.footver{border:0;background:none;padding:0;min-height:0;font:inherit;color:inherit;cursor:pointer}.footver:hover{color:hsl(var(--foreground));text-decoration:underline}
.foot b{color:hsl(var(--foreground));font-weight:600}.foot .newer{color:hsl(var(--warning));font-weight:600}
.foot .right{overflow:hidden;text-overflow:ellipsis}
.rail{position:sticky;top:0;height:calc(100vh - var(--foot));overflow:auto;padding:18px 14px;border-right:1px solid hsl(var(--border));background:hsl(var(--surface));display:flex;flex-direction:column;gap:14px}
.brand{display:flex;align-items:center;gap:10px;padding:2px 6px}
.logo{width:44px;height:48px;flex:none}
/* The mascot has a light and a dark artwork; the page shows the one for its theme (data-theme, else the device), as it does for the colours. */
.logo-dark{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .logo-light{display:none}:root:not([data-theme=light]) .logo-dark{display:inline}}
:root[data-theme=dark] .logo-light{display:none}:root[data-theme=dark] .logo-dark{display:inline}
.brand b{font-size:1.02rem;letter-spacing:.2px}.brand .small{display:block}
.agentcard{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:14px;padding:12px}
.agentcard h1{font-size:1.05rem;margin:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.badge{font-size:.75rem;font-weight:600;letter-spacing:.3px;text-transform:uppercase;padding:2px 7px;border-radius:99px;background:hsl(var(--info-surface));color:hsl(var(--info))}
.sub{color:hsl(var(--muted-foreground));margin:6px 0 0;font-size:.86rem;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.sub.open{display:block}
.statusline{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:.85rem;font-weight:600}
.dot{width:9px;height:9px;border-radius:50%;background:hsl(var(--muted-foreground));box-shadow:0 0 0 3px hsl(var(--muted))}
.dot.ask{background:hsl(var(--warning));box-shadow:0 0 0 3px hsl(var(--warning-surface))}.dot.act{background:hsl(var(--success));box-shadow:0 0 0 3px hsl(var(--success-surface))}.dot.stop{background:hsl(var(--destructive));box-shadow:0 0 0 3px hsl(var(--destructive-surface))}
nav.tabs{display:flex;flex-direction:column;gap:2px}
nav.tabs button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:none;color:hsl(var(--muted-foreground));padding:9px 10px;border-radius:10px;font-weight:500}
nav.tabs button svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
nav.tabs button:hover{background:hsl(var(--card));color:hsl(var(--foreground))}
nav.tabs button[aria-selected=true]{background:hsl(var(--card));color:hsl(var(--foreground));box-shadow:inset 3px 0 0 hsl(var(--primary))}
.engine{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:14px;padding:12px;font-size:.84rem}
.engine h3,.panelhead h3{margin:0 0 8px;font-size:.75rem;letter-spacing:.8px;text-transform:uppercase;color:hsl(var(--muted-foreground))}
.chain{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.chain span.b{font-family:ui-monospace,monospace;font-size:.78rem;padding:2px 7px;border-radius:7px;background:hsl(var(--muted))}
.chain span.b.local{background:hsl(var(--info-surface));color:hsl(var(--info))}
.chain i{color:hsl(var(--muted-foreground));font-style:normal;font-size:.75rem}
.engine dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:10px 0 0}.engine dt{color:hsl(var(--muted-foreground))}.engine dd{margin:0;font-family:ui-monospace,monospace;font-size:.78rem;word-break:break-all}
.railfoot{margin-top:auto;color:hsl(var(--muted-foreground));font-size:.75rem;padding:0 6px}
main{padding:22px 28px 60px;width:100%;min-width:0}

/* panels */
section{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius);padding:18px;box-shadow:var(--elevation-card)}
h2{font-size:var(--text-h3);font-weight:var(--text-h3-weight);line-height:var(--leading-h3);margin:0 0 10px}
.hint{color:hsl(var(--muted-foreground));font-size:.86rem;margin:4px 0 0}
.small{font-size:.8rem;color:hsl(var(--muted-foreground))}
.card{border:1px solid hsl(var(--border));background:hsl(var(--muted));border-radius:12px;padding:12px;margin-top:10px}
.what{font-weight:600;margin:0 0 4px}.meta{color:hsl(var(--muted-foreground));font-size:.86rem;margin:2px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
button{font:inherit;border-radius:10px;border:1px solid hsl(var(--input));background:hsl(var(--card));color:hsl(var(--foreground));padding:8px 14px;cursor:pointer;min-height:38px}
button:hover{border-color:hsl(var(--muted-foreground))}
/* One ring for everything a keyboard can reach (spec §5): the token's width and offset, never removed. */
:focus-visible{outline:var(--focus-ring-width) solid hsl(var(--ring));outline-offset:var(--focus-ring-offset)}
button.primary{background:var(--gradient-accent);border-color:transparent;color:hsl(var(--primary-foreground));font-weight:600}
button.danger{background:transparent;border-color:hsl(var(--destructive));color:hsl(var(--destructive));font-weight:600}
button.danger:hover{background:hsl(var(--destructive-surface))}
button:disabled{opacity:.5;cursor:default}
input[type=text],textarea,select{font:inherit;width:100%;border:1px solid hsl(var(--input));border-radius:10px;padding:9px 11px;background:hsl(var(--surface));color:hsl(var(--foreground))}
textarea{min-height:70px;resize:vertical}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.chip{font-size:.76rem;padding:2px 9px;border-radius:99px}
.chip.calm{background:hsl(var(--muted));color:hsl(var(--muted-foreground))}.chip.care{background:hsl(var(--warning-surface));color:hsl(var(--warning))}.chip.warn{background:hsl(var(--destructive-surface));color:hsl(var(--destructive))}
.pill{font-weight:600;padding:4px 12px;border-radius:99px;display:inline-block}
.pill.ask{background:hsl(var(--warning-surface));color:hsl(var(--warning))}.pill.act{background:hsl(var(--success-surface));color:hsl(var(--success))}.pill.stop{background:hsl(var(--destructive-surface));color:hsl(var(--destructive))}
ul.plain{list-style:none;padding:0;margin:0}ul.plain li{padding:8px 0;border-top:1px solid hsl(var(--border))}ul.plain li:first-child{border-top:0}
.empty{color:hsl(var(--muted-foreground));font-style:italic}
.toast{position:fixed;left:50%;bottom:calc(22px + var(--foot));transform:translateX(-50%);background:hsl(var(--foreground));color:hsl(var(--background));padding:10px 16px;border-radius:12px;max-width:90vw;white-space:pre-wrap;display:none;z-index:50;box-shadow:var(--elevation-card)}
footer{color:hsl(var(--muted-foreground));font-size:.8rem;margin-top:22px}

/* home: full width — status across the top, the chat and what waits side by side, the rest beneath */
.grid{display:grid;gap:18px;align-items:start;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);
  grid-template-areas:"chat status" "chat wait" "chat recent" "chat sched" "chat term"}
.a-status{grid-area:status}.a-chat{grid-area:chat}.a-wait{grid-area:wait}.a-recent{grid-area:recent}.a-sched{grid-area:sched}.a-term{grid-area:term}
.upper{text-transform:uppercase;letter-spacing:.8px;font-size:.75rem;margin:0 0 6px}
.statusbar{display:flex;align-items:center;gap:14px 22px;flex-wrap:wrap;padding:14px 18px}
.sb-main{flex:1 1 100%;min-width:0}.sb-level{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.sb-level .hint{margin:0}
.sb-next{flex:1 1 200px}.sb-next div{font-size:.86rem}
.sb-stop{display:flex;align-items:center;gap:12px}.sb-stop .hint{margin:0}
.waitpanel{display:flex;flex-direction:column;max-height:70vh}
.waitscroll{overflow:auto;flex:1;margin:0 -6px;padding:0 6px}
.waitbar{display:grid;grid-template-columns:1fr auto;gap:6px;margin:10px 0 4px}.waitbar input{grid-column:1/-1}.waitbar input,.waitbar select{padding:6px 9px}.waitbar button{min-height:34px;padding:6px 10px;font-size:.84rem}
.bulk{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px;margin:6px 0;border:1px solid hsl(var(--warning));border-radius:12px;background:hsl(var(--warning-surface))}
.bulk .small{flex:1;color:hsl(var(--warning));font-weight:600}.bulk button{min-height:32px;padding:5px 10px;font-size:.84rem}
.card .pick{display:flex;align-items:center;gap:8px;float:right;margin:-2px -2px 0 8px}.card .pick input{width:18px;height:18px;accent-color:hsl(var(--primary))}
/* A (D-080): the chat stays put while the column beside it scrolls. */
.chatpanel{display:flex;flex-direction:column;position:sticky;top:16px;height:calc(100vh - 32px - var(--foot));min-height:420px}
.panelhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px}
.engineline{font-size:.78rem;color:hsl(var(--muted-foreground));font-family:ui-monospace,monospace;text-align:right}
.chat{flex:1;display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding:4px 2px 10px}
.chat:empty::before{content:"Ask it about this machine, its services, or what it remembers.";color:hsl(var(--muted-foreground));font-size:.9rem;margin:auto;text-align:center;padding:40px 10px}
.msg{padding:10px 13px;border-radius:14px;max-width:min(88%,62rem);white-space:pre-wrap;word-wrap:break-word}
.me{align-self:flex-end;background:var(--gradient-accent);color:hsl(var(--primary-foreground));border-bottom-right-radius:4px}
.it{align-self:flex-start;background:hsl(var(--muted));border:1px solid hsl(var(--border));border-bottom-left-radius:4px}
/* D-086: what a /command said — the page's own voice, not the agent's. */
.sys{align-self:center;background:hsl(var(--muted));border:1px dashed hsl(var(--border));font-size:.88rem;max-width:min(94%,62rem);white-space:normal}
.sys .row{margin-top:8px}
/* S12.4: the level-2 change report under an answer — collapsed until asked for. */
.changed{margin-top:6px;border-top:1px dashed hsl(var(--border));padding-top:6px;font-size:.8rem;color:hsl(var(--muted-foreground))}
.changed summary{cursor:pointer}
.changed ul{list-style:none;margin:6px 0 0;padding:0}
.changed li{font-family:ui-monospace,monospace;font-size:.76rem;overflow-wrap:anywhere;padding:2px 0}
.composer{position:relative}
.cmdmenu{position:absolute;left:8px;right:8px;bottom:calc(100% + 6px);background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:12px;box-shadow:var(--elevation-card);max-height:min(46vh,380px);overflow:auto;z-index:20;padding:4px}
.cmdmenu button{display:flex;gap:10px;width:100%;text-align:left;border:0;background:none;border-radius:8px;padding:7px 10px;min-height:0;align-items:baseline}
.cmdmenu button[aria-selected=true],.cmdmenu button:hover{background:hsl(var(--muted))}
.cmdmenu b{font-family:ui-monospace,monospace;font-size:.86rem;white-space:nowrap}.cmdmenu .small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.composer{border:1px solid hsl(var(--input));border-radius:14px;background:hsl(var(--surface));padding:8px;margin-top:6px}
.composer textarea{border:0;background:transparent;min-height:56px;padding:6px}
.composer textarea:focus-visible{outline:none}
.composer:focus-within{outline:2px solid hsl(var(--ring));outline-offset:2px;border-color:hsl(var(--ring))}
.composer .row{margin-top:4px;justify-content:space-between}
/* D-085: who answers, switched from the chat itself. */
.pickchip{border:1px solid hsl(var(--input));background:hsl(var(--surface));border-radius:99px;padding:3px 11px;font-size:.78rem;min-height:30px;color:hsl(var(--muted-foreground));max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pickchip b{color:hsl(var(--foreground));font-weight:600}
.pickrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 4px 8px;border-bottom:1px solid hsl(var(--border));margin-bottom:4px}
.pickrow select,.pickrow input{width:auto;flex:1 1 150px;min-height:34px;padding:5px 9px;font-size:.84rem}
.status{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.thinking .logo,.think img{animation:bob .9s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-4px) scale(1.06)}}
.think{display:inline-flex;align-items:center;gap:6px}.think img{width:26px;height:28px}
@media (prefers-reduced-motion:reduce){.thinking .logo,.think img{animation:none}}

/* other tabs */
/* Cards flow into columns like a masonry wall: a short card no longer leaves a hole below it (2K audit). */
.set{columns:30rem;column-gap:18px}
.set>section,.set>.card,.set>p{break-inside:avoid;margin:0 0 18px;display:block}
.set>section:last-child{margin-bottom:0}
#profile.set{columns:auto;display:grid;grid-template-columns:minmax(0,64rem);gap:18px}
#profile.set>section{margin:0}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}.kv dt{color:hsl(var(--muted-foreground))}.kv dd{margin:0;word-break:break-word}
.notes{white-space:pre-wrap;font-size:.9rem;background:hsl(var(--surface));border:1px solid hsl(var(--border));border-radius:12px;padding:12px;max-height:340px;overflow:auto;margin:6px 0 0}
.memgrid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:18px;align-items:start}
.memlist{max-height:70vh;overflow:auto}
/* D-082: the memories as neurons and the links between them as synapses, turning in 3D. */
.memmap{grid-column:1/-1}
.kindseg{margin-bottom:0}.kindseg button[aria-pressed=true]{background:hsl(var(--card));color:hsl(var(--foreground));font-weight:600;box-shadow:var(--elevation-card)}
.tag.kn{background:hsl(var(--warning-surface));color:hsl(var(--warning))}
/* D-093: facts drawn out of memory, answered one by one. */
.fact{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 0;border-top:1px solid hsl(var(--border))}
.fact:first-child{border-top:0}.fact .q{font-size:.8rem;color:hsl(var(--muted-foreground));margin-top:3px}.fact .q button{border:0;background:none;padding:0;min-height:0;color:hsl(var(--primary-text));font:inherit;cursor:pointer;text-decoration:underline}
.fact .yn{display:flex;gap:6px;flex:none}.fact.done{opacity:.6}
/* D-091: collections — the tags in a memory's front matter. */
.tagrow{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}
.tagchip{border:1px solid hsl(var(--input));background:hsl(var(--surface));border-radius:99px;padding:2px 10px;font-size:.78rem;min-height:26px;color:hsl(var(--muted-foreground))}
.tagchip[aria-pressed=true]{background:hsl(var(--info-surface));color:hsl(var(--info));border-color:hsl(var(--info));font-weight:600}
.tagchip b{font-weight:600;margin-left:4px;color:hsl(var(--foreground));opacity:.6}
/* D-084: import — drop files or paste a link; each is checked before anything is written. */
.drop{display:block;border:2px dashed hsl(var(--input));border-radius:14px;padding:22px 14px;text-align:center;cursor:pointer;background:hsl(var(--surface))}
.drop.over,.drop:focus-within{border-color:hsl(var(--primary));background:hsl(var(--info-surface))}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.queue li{padding:10px 0;border-top:1px solid hsl(var(--border))}.queue li:first-child{border-top:0}
.queue .msg{white-space:pre-wrap;font-size:.8rem;color:hsl(var(--muted-foreground));margin-top:4px;font-family:ui-monospace,monospace}
.mapwrap{position:relative;height:clamp(320px,54vh,780px);border-radius:14px;overflow:hidden;border:1px solid hsl(var(--border));background:radial-gradient(ellipse at 50% 42%,hsl(var(--muted)),hsl(var(--surface)) 72%);touch-action:pan-y}
.mapwrap canvas{width:100%;height:100%;display:block;cursor:grab}.mapwrap canvas.grabbing{cursor:grabbing}
.maptip{position:absolute;pointer-events:none;background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:10px;padding:6px 10px;font-size:.82rem;box-shadow:var(--elevation-card);max-width:300px;z-index:2}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;font-size:.8rem;color:hsl(var(--muted-foreground))}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
/* The map shows a part of memory at a time: found, around one memory, the most linked, some kinds. */
.maptools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}
.maptools input[type=text]{flex:1 1 220px;width:auto;min-width:0}.maptools select{width:auto;flex:0 1 auto}
.legchip{border:1px solid hsl(var(--input));background:hsl(var(--surface));border-radius:99px;padding:2px 10px;font-size:.78rem;min-height:26px;color:hsl(var(--muted-foreground))}
.mapempty{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:hsl(var(--muted-foreground));pointer-events:none}
.legchip b{font-weight:600;margin-left:4px;color:hsl(var(--foreground));opacity:.6}.legchip[aria-pressed=false]{opacity:.45;text-decoration:line-through}
.mem{display:block;width:100%;text-align:left;border:0;border-top:1px solid hsl(var(--border));border-radius:0;padding:10px 6px;background:none;min-height:0}
.mem:first-child{border-top:0}.mem:hover,.mem[aria-current=true]{background:hsl(var(--muted));border-radius:10px}
.tag{font-size:.75rem;padding:1px 7px;border-radius:99px;background:hsl(var(--info-surface));color:hsl(var(--info));margin-left:6px;font-weight:600}
.stat{display:inline-block;margin:0 22px 10px 0}.stat b{font-size:1.5rem;display:block;font-family:ui-monospace,monospace}
.cat{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 0;border-top:1px solid hsl(var(--border))}
.cat:first-of-type{border-top:0}
.seg{display:inline-flex;border:1px solid hsl(var(--input));border-radius:11px;overflow:hidden;background:hsl(var(--surface))}
.seg button{border:0;border-radius:0;border-left:1px solid hsl(var(--border));padding:7px 11px;font-size:.86rem;background:none;min-height:36px}
.seg button:first-child{border-left:0}
.seg button[aria-pressed=true]{background:var(--gradient-accent);color:hsl(var(--primary-foreground));font-weight:600}
.lock{font-size:.78rem;color:hsl(var(--muted-foreground));margin-left:8px}
.field{display:grid;gap:4px;margin-top:10px}
.on{color:hsl(var(--success));font-weight:600}.off{color:hsl(var(--muted-foreground));font-weight:600}
.steps{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.steps button{font-size:.8rem;padding:4px 10px;border-radius:99px;min-height:30px}
.steps button[aria-current=step]{background:var(--gradient-accent);color:hsl(var(--primary-foreground));border-color:transparent}
.steps button.done{border-color:hsl(var(--success));color:hsl(var(--success))}
.wiz label{display:block;font-weight:600;margin:14px 0 2px}.wiz .hint{margin:0 0 6px}
.wiz textarea{min-height:90px}.wiz textarea.long{min-height:260px;font-family:ui-monospace,monospace;font-size:.84rem}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.more{margin-top:10px;width:100%}
.linkish{border:0;background:none;color:hsl(var(--muted-foreground));font-size:.78rem;font-weight:500;padding:0 6px;min-height:0;text-decoration:underline;cursor:pointer}
.recentitem{cursor:pointer;border-radius:8px;padding:8px 6px!important}.recentitem:hover{background:hsl(var(--muted))}
.recentitem .detail{margin-top:8px;cursor:auto}.recentitem .detail .notes{max-height:260px}
#expired{border-color:hsl(var(--destructive))}

/* large screens: type and chrome grow with the screen (2K audit) */
@media (min-width:1920px){html{font-size:16px}.app{grid-template-columns:290px 1fr}main{padding:28px 36px 60px}
  #profile.set{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start}}
@media (min-width:2400px){html{font-size:17.5px}.app{grid-template-columns:320px 1fr}}
/* narrow desktop */
@media (max-width:1000px){.app{grid-template-columns:220px 1fr}.grid{grid-template-columns:1fr;grid-template-areas:"status" "chat" "wait" "recent" "sched" "term"}.chatpanel{height:auto;min-height:0}.chat{max-height:60vh;min-height:260px}.waitpanel{max-height:none}.set{columns:1}}

/* phone: a top bar, the chat first, and a bottom tab bar */
@media (max-width:760px){
  body{font-size:16px}
  .app{display:block}
  .rail{position:sticky;top:0;z-index:20;height:auto;overflow:visible;flex-direction:row;align-items:center;gap:10px;padding:8px 14px;border-right:0;border-bottom:1px solid hsl(var(--border))}
  .brand .small,.brand b,.engine,.railfoot{display:none}
  .logo{width:36px;height:40px}
  .agentcard{background:none;border:0;padding:0;flex:1;min-width:0}
  .agentcard h1{font-size:1rem;flex-wrap:nowrap}
  .agentcard h1 #name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sub{-webkit-line-clamp:1;margin-top:0;font-size:.8rem}
  .statusline{margin-top:2px;font-size:.78rem}
  :root{--foot:calc(22px + env(safe-area-inset-bottom))}
  .foot{height:var(--foot);padding:0 12px env(safe-area-inset-bottom);font-size:.75rem}
  nav.tabs{position:fixed;left:0;right:0;bottom:var(--foot);z-index:30;flex-direction:row;justify-content:space-around;gap:0;padding:6px 4px 6px;background:hsl(var(--surface));border-top:1px solid hsl(var(--border));backdrop-filter:blur(12px)}
  nav.tabs button{flex-direction:column;gap:2px;width:auto;flex:1;padding:6px 2px;font-size:.75rem;text-align:center;min-height:0}
  nav.tabs button svg{width:22px;height:22px}
  nav.tabs button[aria-selected=true]{background:none;box-shadow:none;color:hsl(var(--primary-text))}
  main{padding:14px 14px calc(96px + var(--foot))}
  section{padding:14px;border-radius:14px}
  .grid{gap:14px;grid-template-areas:"chat" "status" "wait" "recent" "sched" "term"}
  .memgrid{grid-template-columns:1fr;gap:14px}
  .mapwrap{height:clamp(260px,46vh,520px)}
  .statusbar{gap:12px}.sb-stop{width:100%;justify-content:space-between}
  .chatpanel{position:static;height:auto;min-height:0}
  .chat{max-height:none;min-height:120px}
  /* C (D-080): the message box sits above the tab bar, like a messenger. */
  .composer{position:fixed;left:0;right:0;bottom:calc(62px + var(--foot));z-index:25;margin:0;border-radius:14px 14px 0 0;border-width:1px 0 0;padding:8px 10px;background:hsl(var(--surface));box-shadow:var(--elevation-raised)}
  .composer textarea{min-height:42px;max-height:30vh}
  .composer .row{margin-top:2px}
  .composer #sending{font-size:.75rem}
  main.homeon{padding-bottom:calc(190px + var(--foot))}
  .engineline{text-align:left}
  .panelhead{flex-direction:column}
  .cat>div:last-child{width:100%}
  .seg{display:flex;width:100%}.seg button{flex:1 1 0;padding:9px 4px;font-size:.82rem}
  .kv{grid-template-columns:1fr;gap:0}.kv dt{margin-top:8px;font-size:.82rem}
  .msg{max-width:94%}
  .memlist{max-height:none}
  .toast{bottom:calc(84px + var(--foot))}
}
/* Phone audit (D-094, 2026-09-26, 360/390/430 wide): no text under 11px, every control at least 36px to touch, long words wrap. */
#capLines li,ul.plain li,.notes,.md{overflow-wrap:anywhere}
@media (max-width:760px){
  nav.tabs button{font-size:.76rem}
  .badge{font-size:.75rem}.tag{font-size:.75rem}.upper{font-size:.76rem}
  code{font-size:max(.86em,11px)}
  .linkish{min-height:36px;padding:0 8px}
  .pickchip{min-height:36px}
  .steps button{min-height:36px;font-size:.82rem}
  .bulk button{min-height:36px}
  .changed summary{min-height:36px;display:flex;align-items:center}
  :root{--foot:calc(32px + env(safe-area-inset-bottom))}
  .foot{font-size:.76rem}.footver{min-height:32px}
  .composer #sending{font-size:.76rem}
  .cmdmenu button{flex-wrap:wrap;row-gap:0}.cmdmenu b{white-space:normal;overflow-wrap:anywhere}.cmdmenu .small{white-space:normal;flex-basis:100%}
}
${MARKDOWN_CSS}
/* Skip link (spec §5): first on the page, shown when it is focused. */
.skip{position:absolute;left:8px;top:-60px;z-index:100;padding:10px 16px;border-radius:var(--radius-lg);background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-weight:600;text-decoration:none}
.skip:focus{top:8px}
main:focus{outline:none}
/* The theme button (spec §6): the word and an icon, whichever state it is in. */
.themebtn{display:flex;align-items:center;gap:8px;width:100%;justify-content:flex-start;background:none;color:hsl(var(--muted-foreground))}
.themebtn svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.themebtn svg:not(.shown){display:none}
.sronly{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:760px){.themebtn{width:auto;flex:none;padding:8px 10px}.themebtn #themeLabel{display:none}}
/* Touch (spec §5): anything a finger taps is 44px; the version button in the footer bar keeps the bar's own 28px, above the 24px floor. */
@media (pointer:coarse){button:not(.footver),select,input[type=text],input[type=search]{min-height:var(--touch-min)!important}.tagchip,.legchip,.pickchip{min-height:var(--touch-min)!important}}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <aside class="rail">
    <div class="brand"><img class="logo logo-light" src="${MASCOT_LIGHT_DATA_URI}" alt="" aria-hidden="true"><img class="logo logo-dark" src="${MASCOT_DARK_DATA_URI}" alt="" aria-hidden="true"><div><b>Mind</b><span class="small">agent console</span></div></div>
    <div class="agentcard">
      <h1><span id="name">Your agent</span><span class="badge">AI</span></h1>
      <p class="sub" id="role">Loading…</p>
      <div class="statusline"><span class="dot" id="statusDot"></span><span id="statusText">…</span></div>
    </div>
    <nav class="tabs" role="tablist" aria-label="Sections">
      <button role="tab" id="tabHome" aria-selected="true" aria-controls="home"><svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg><span>Home</span></button>
      <button role="tab" id="tabAgent" tabindex="-1" aria-selected="false" aria-controls="agent"><svg viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5h5"/></svg><span>Agent</span></button>
      <button role="tab" id="tabProfile" tabindex="-1" aria-selected="false" aria-controls="profile"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/></svg><span>Profile</span></button>
      <button role="tab" id="tabMemories" tabindex="-1" aria-selected="false" aria-controls="memories"><svg viewBox="0 0 24 24"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V4.5A2.5 2.5 0 0 0 9 4Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/></svg><span>Memories</span></button>
      <button role="tab" id="tabTasks" tabindex="-1" aria-selected="false" aria-controls="tasks"><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/></svg><span>Tasks</span></button>
      <button role="tab" id="tabPrivacy" tabindex="-1" aria-selected="false" aria-controls="privacy"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg><span>Privacy</span></button>
      <button role="tab" id="tabSettings" tabindex="-1" aria-selected="false" aria-controls="settings"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg><span>Settings</span></button>
    </nav>
    <div class="engine" aria-labelledby="h-engine">
      <h3 id="h-engine">Engine</h3>
      <div class="chain" id="engChain"></div>
      <dl>
        <dt>Local</dt><dd id="engLocal">—</dd>
        <dt>Judge</dt><dd id="engJudge">—</dd>
        <dt>Last</dt><dd id="engLast">—</dd>
      </dl>
    </div>
    <button type="button" class="themebtn" id="themeBtn" aria-label="Theme: System" title="Change theme" data-state="system">
      <svg class="shown" data-for="system" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
      <svg data-for="light" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg data-for="dark" viewBox="0 0 24 24"><path d="M21 13a8 8 0 1 1-10-10 6.5 6.5 0 0 0 10 10Z"/></svg>
      <span id="themeLabel">System</span>
    </button>
    <span class="sronly" role="status" id="themeStatus"></span>
    <p class="railfoot">Everything here stays on this computer. A message goes only to the backend named under its answer.</p>
  </aside>
<main class="homeon" id="main" tabindex="-1">
  <div id="expired" class="card" style="display:none;border-color:hsl(var(--destructive))">
    <p style="margin:0 0 8px">This page needs the full link that <code>mind web</code> printed — the part after <code>#t=</code> is its key. Paste the link (or just the key) here:</p>
    <div class="row" style="margin:0"><input type="text" id="keyIn" placeholder="https://…#t=…" autocomplete="off" aria-label="Link or key" style="flex:1;min-width:220px"><button class="primary" id="keyGo">Open</button></div>
  </div>

  <div class="grid" id="home" role="tabpanel" aria-labelledby="tabHome">
    <section class="a-status statusbar" aria-labelledby="h-status">
      <div class="sb-main">
        <h2 id="h-status" class="small upper">On its own, it…</h2>
        <div class="sb-level"><span class="pill" id="level">…</span><span class="hint" id="levelDetail"></span></div>
        <div class="hint" id="operateLine"></div>
      </div>
      <div class="sb-next"><h2 class="small upper">Next scheduled</h2><div id="nextRun" class="mono">—</div></div>
      <div class="sb-stop"><button class="danger" id="stopBtn" title="Stops every running turn and sets every category to 0">Stop everything</button><span class="hint">Safe to press any time.</span></div>
    </section>

    <section class="a-chat chatpanel" aria-labelledby="h-chat">
      <div class="panelhead"><h2 id="h-chat">Talk to it <button class="linkish" id="chatClear" title="Clear this browser's copy of the conversation">Clear</button></h2><div class="engineline" id="engineLine"></div></div>
      <div class="chat" id="chat" aria-live="polite"></div>
      <div class="composer">
        <label class="small" for="prompt" style="position:absolute;left:-9999px">Your message</label>
        <div class="pickrow" id="pickRow" hidden>
          <select id="chatBackend" aria-label="Backend for this chat"></select>
          <input type="text" id="chatModel" list="chatModelList" placeholder="Model — blank for its default" aria-label="Model for this chat" autocomplete="off" spellcheck="false">
          <datalist id="chatModelList"></datalist>
        </div>
        <div class="cmdmenu" id="cmdMenu" role="listbox" aria-label="Commands" hidden></div>
        <textarea id="prompt" placeholder="Ask a question, or tell it what you'd like done…" aria-describedby="sending"></textarea>
        <div class="row"><span class="small think" id="sending">Ctrl+Enter to send · / for commands</span><div class="row" style="margin:0;gap:8px;flex-wrap:nowrap;min-width:0"><button class="pickchip" id="chatPick" aria-expanded="false" aria-controls="pickRow" title="Switch backend and model">…</button><button class="primary" id="send">Send</button></div></div>
      </div>
    </section>

    <section class="a-wait waitpanel" aria-labelledby="h-wait">
      <h2 id="h-wait">Waiting for you <span class="small" id="waitCount"></span></h2>
      <p class="hint">Nothing happens until you say yes — and a yes is good for one run.</p>
      <div class="waitbar">
        <input type="text" id="waitFilter" placeholder="Filter…" aria-label="Filter what is waiting" autocomplete="off">
        <select id="waitWho" aria-label="Who suggested it"><option value="">Everyone</option><option value="agent">By the agent</option><option value="you">By you</option></select>
        <button id="waitSelectAll" title="Select every card shown">Select shown</button>
      </div>
      <div class="bulk" id="bulkBar" hidden><span class="small" id="bulkCount"></span><button class="primary" id="bulkYes">Allow once</button><button id="bulkNo">Decline</button><button id="bulkClear">Clear</button></div>
      <div class="waitscroll"><div id="waiting"></div><div id="approved"></div></div>
    </section>

    <section class="a-recent" aria-labelledby="h-recent">
      <h2 id="h-recent">Recently</h2>
      <ul class="plain" id="recent"></ul>
    </section>
    <section class="a-sched" aria-labelledby="h-sched">
      <h2 id="h-sched">On a schedule</h2>
      <ul class="plain" id="triggers"></ul>
      <p class="hint">Scheduled work only ever makes suggestions — they land in “Waiting for you”.</p>
    </section>
    <section class="a-term" aria-labelledby="h-term">
      <h2 id="h-term">Only in the terminal</h2>
      <p class="hint">These need you to type a phrase yourself, on purpose:</p>
      <ul class="plain small">
        <li>Let it act without asking — <code>mind autonomy set … 3</code></li>
        <li>Let it learn what you do — <code>mind observe enable</code></li>
        <li>Release the brake — <code>mind autonomy resume</code></li>
        <li>Delete your data — <code>mind erase</code></li>
      </ul>
    </section>
  </div>
  <div class="set" id="agent" role="tabpanel" aria-labelledby="tabAgent" hidden>
    <p id="agentProblems" class="card" style="display:none;border-color:hsl(var(--destructive))"></p>
    <section aria-labelledby="h-who">
      <h2 id="h-who">Who it is</h2>
      <dl class="kv" id="whoKv"></dl>
      <p class="hint">It always says it is an AI when asked — that is built in and cannot be turned off.</p>
    </section>
    <section aria-labelledby="h-repo">
      <h2 id="h-repo">Its repository</h2>
      <dl class="kv" id="repoKv"></dl>
    </section>
    <section aria-labelledby="h-scope">
      <h2 id="h-scope">What it does, and never does</h2>
      <dl class="kv" id="scopeKv"></dl>
      <p class="small" style="margin:12px 0 4px">It never:</p>
      <ul class="plain" id="prohibitions"></ul>
    </section>
    <section aria-labelledby="h-person">
      <h2 id="h-person">How it speaks</h2>
      <dl class="kv" id="personKv"></dl>
      <p class="small" style="margin:12px 0 4px">Its principles:</p>
      <ul class="plain" id="principles"></ul>
    </section>
    <section aria-labelledby="h-stats">
      <h2 id="h-stats">So far</h2>
      <div id="stats"></div>
      <ul class="plain small" id="byBackend"></ul>
    </section>
    <section aria-labelledby="h-notes">
      <h2 id="h-notes">Its own notes</h2>
      <p class="small">role.md — the job</p><div class="notes" id="roleNotes"></div>
      <p class="small" style="margin-top:12px">person.md — the person</p><div class="notes" id="personNotes"></div>
      <p class="hint">To change who it is, edit <code>soul/role.md</code> or <code>soul/person.md</code> and run <code>mind soul check</code>.</p>
    </section>
  </div>

  <div class="set" id="profile" role="tabpanel" aria-labelledby="tabProfile" hidden>
    <section class="wiz" aria-labelledby="h-wiz">
      <h2 id="h-wiz">Set up this agent</h2>
      <p class="hint">Every axis of who it is, one step at a time. Nothing is saved until the last step, and what is saved must still pass every check a soul goes through — the AI disclosure is built in and cannot be edited.</p>
      <nav class="steps" id="wizSteps" aria-label="Steps"></nav>
      <div id="wizBody"></div>
      <div class="row" style="margin-top:16px"><button id="wizBack">Back</button><button class="primary" id="wizNext">Next</button><span class="small" id="wizNote"></span></div>
    </section>
    <section aria-labelledby="h-drafts">
      <h2 id="h-drafts">Drafts from real work <span class="small" id="draftCount"></span></h2>
      <p class="hint">What a model on this machine drew from the artifacts you gave it (<code>mind persona extract</code>). Each claim quotes its source; answer whether it is true of the job. Only the yeses can be written into the soul.</p>
      <div class="waitbar"><select id="draftShow" aria-label="Which claims"><option value="open">Not answered yet</option><option value="yes">Answered yes</option><option value="no">Answered no</option><option value="all">All</option></select><button id="draftAdopt">Write the yeses…</button></div>
      <div id="draftList"></div>
    </section>
  </div>

  <div class="memgrid" id="memories" role="tabpanel" aria-labelledby="tabMemories" hidden>
    <section class="memmap" aria-labelledby="h-map">
      <div class="panelhead"><h2 id="h-map">Memory map <span class="small" id="mapStats"></span></h2><div class="row" style="margin:0"><button id="mapEntities" aria-pressed="false" title="Ports, services, hosts, env names and paths that two or more memories mention">Things</button><button id="mapSpin" aria-pressed="true">Spin</button><button id="mapReset">Reset view</button><button id="mapToggle" aria-expanded="true">Hide map</button></div></div>
      <div id="mapBody">
        <div class="maptools" role="group" aria-label="What the map shows">
          <input type="text" id="mapFind" placeholder="Find in the map…" aria-label="Find in the map" autocomplete="off" spellcheck="false">
          <select id="mapLimit" aria-label="How many memories"><option value="60">60 most linked</option><option value="150">150 most linked</option><option value="300">300 most linked</option><option value="0">All</option></select>
          <select id="mapAround" aria-label="Around which memory"><option value="0">Whole map</option><option value="1">Around the chosen memory</option><option value="2">Two steps around it</option></select>
          <label class="small"><input type="checkbox" id="mapLoose"> show unlinked</label>
          <button id="mapClear" class="linkish" hidden>Clear filters</button>
        </div>
        <div class="mapwrap"><canvas id="mapCanvas" role="img" aria-label="Memory map: each memory is a dot, each link between two memories a line. The list below holds the same memories."></canvas><div class="maptip" id="mapTip" hidden></div><div class="mapempty" id="mapEmpty" hidden></div></div>
        <div class="legend" id="mapLegend" role="group" aria-label="Kinds on the map"></div>
        <p class="hint">Each dot is a memory, sized by how many others it links to; each line is a <code>[[link]]</code> between two of them, with signals running along it. Drag to turn it, scroll to zoom, click a dot to read it. A big memory shows its most linked part: find narrows it to what matches and what that links to, a kind in the legend turns off with a click, and <i>Around the chosen memory</i> shows one memory and its links — click a dot to walk on. The filter below dims what does not match.</p>
      </div>
    </section>
    <section class="memmap" aria-labelledby="h-facts">
      <div class="panelhead"><h2 id="h-facts">Facts to confirm <span class="small" id="factStats"></span></h2><div class="row" style="margin:0"><button id="factStart">Draw facts…</button><button class="primary" id="factAdopt" disabled>Write the yeses</button></div></div>
      <p class="hint">The local model reads your knowledge (or, with Memory chosen above, all of memory) and offers short facts, each quoting the words it came from — one whose quote is not there is cut. Say yes to the true ones; only those are written, to <code>memory/knowledge/facts/</code>.</p>
      <div id="factList"></div>
    </section>
    <section aria-labelledby="h-mem">
      <div class="panelhead"><h2 id="h-mem">Memories <span class="small" id="memCount"></span></h2><div class="row" style="margin:0"><button id="memImp">Import…</button><button class="primary" id="memNew">New memory</button></div></div>
      <div class="seg kindseg" id="memKind" role="group" aria-label="Which kind"><button data-kind="" aria-pressed="true">All</button><button data-kind="memory" aria-pressed="false">Memory</button><button data-kind="knowledge" aria-pressed="false">Knowledge</button></div>
      <p class="hint" style="margin:6px 0 10px">Memory is what it keeps of the person and what happened; knowledge is documents and pages brought in to look things up in (<code>memory/knowledge/</code>).</p>
      <div class="tagrow" id="memTags" role="group" aria-label="Collections"></div>
      <label class="small" for="memFilter">Filter by words</label>
      <input type="text" id="memFilter" placeholder="Type to narrow the list…" autocomplete="off">
      <div class="row"><select id="memType" aria-label="Kind"><option value="">All kinds</option></select><button id="memSearch" title="Ask your memory: a short answer from what recall finds, with its sources">Search by meaning</button></div>
      <div class="memlist" id="memList" style="margin-top:10px"></div>
    </section>
    <section aria-labelledby="h-memview">
      <div class="panelhead"><h2 id="h-memview">Read</h2><div class="row" style="margin:0" id="memActions" hidden><button id="memMove">Move…</button><button id="memEdit">Edit</button><button class="danger" id="memDelete">Delete…</button></div></div>
      <div class="row" style="justify-content:space-between;margin-top:0"><p class="small" id="memPath" style="margin:0">Pick a memory on the left.</p><label class="small"><input type="checkbox" id="memRaw"> show as written</label></div>
      <div class="row" id="memTagBox" hidden style="margin:0 0 8px;gap:8px;align-items:center"><span class="small">Collections:</span><span id="memTagList" class="tagrow" style="margin:0"></span><button id="memTagEdit" class="linkish">Edit tags</button></div>
      <div class="notes" id="memText" style="max-height:70vh" hidden></div>
      <div id="memEditor" hidden>
        <label class="small" for="memEdPath">File</label>
        <input type="text" id="memEdPath" autocomplete="off" spellcheck="false">
        <label class="small" for="memEdText" style="display:block;margin-top:10px">Markdown</label>
        <textarea id="memEdText" class="mono" spellcheck="false" style="min-height:48vh;font-size:.86rem"></textarea>
        <div class="notes" id="memEdPreview" hidden style="white-space:normal;max-height:48vh"></div>
        <div class="row"><button class="primary" id="memEdSave">Save</button><button id="memEdPrev">Preview</button><button id="memEdCancel">Cancel</button><span class="small" id="memEdNote"></span></div>
      </div>
      <div id="memImport" hidden>
        <label class="drop" id="memDrop"><input type="file" class="vh" id="memFiles" multiple accept=".md,.markdown,.txt,.html,.htm,.pdf,.docx,.doc,.odt,.rtf,.pptx,.ppt,.odp,.epub,.xlsx,.xls,.ods,.csv,.json,.yaml,.yml"><b>Drop files here, or choose them</b><br><span class="small">Markdown, text, PDF, Word, PowerPoint, Excel, OpenDocument, HTML, CSV, JSON — up to 20 MB each</span></label>
        <label class="small" for="memUrl" style="display:block;margin-top:12px">…or a web link</label>
        <div class="row" style="margin-top:4px"><input type="text" id="memUrl" placeholder="https://…" inputmode="url" autocomplete="off" spellcheck="false"><button id="memUrlAdd">Add</button></div>
        <ul class="plain queue" id="memQueue"></ul>
        <div class="row"><button class="primary" id="memImpGo" disabled>Import</button><button id="memImpClose">Close</button><span class="small" id="memImpNote"></span></div>
        <p class="hint">Each one is read into markdown and checked first — where it would go, how it was read — and nothing is written until you press Import. Then it runs <code>mind memory import</code>: the same credential scan and basis as saving, and a long document is cut into parts.</p>
      </div>
      <p class="hint">Saving runs <code>mind memory write</code>: the text must pass the credential scan, a basis for memory must be on record, and both indexes are rebuilt. Deleting runs <code>memory forget</code>. Nothing is committed — git still holds what it was given.</p>
    </section>
  </div>

  <div class="set" id="tasks" role="tabpanel" aria-labelledby="tabTasks" hidden>
    <section aria-labelledby="h-tasknew">
      <h2 id="h-tasknew">Give it a task</h2>
      <p class="hint">A goal it works on over several turns: a plan, then one step per turn, until it is done, its budget is spent, or you stop it. Every step is an ordinary turn — the levels in Settings, the ledger and “Stop everything” all apply.</p>
      <div class="field"><label class="small" for="taskGoal">Goal</label><textarea id="taskGoal" placeholder="What should it get done?"></textarea></div>
      <div class="row">
        <label class="small" for="taskOperate">Browser</label><select id="taskOperate"><option value="0">No browser</option><option value="1">Look only</option><option value="2">Look and act</option></select>
        <input type="text" id="taskAllow" placeholder="Sites it may use, e.g. https://example.com" aria-label="Sites the task's browser may use" autocomplete="off" style="flex:1;min-width:200px">
      </div>
      <div class="row">
        <input type="text" id="taskBackend" placeholder="Backend (blank: the usual; a browser needs claude or claude-local)" aria-label="Backend for the task" autocomplete="off" style="flex:1;min-width:200px">
        <input type="number" id="taskTurns" min="1" max="200" placeholder="Turns (12)" aria-label="Most turns" style="width:7.5rem">
        <input type="number" id="taskMinutes" min="1" max="1440" placeholder="Minutes (30)" aria-label="Most minutes" style="width:7.5rem">
      </div>
      <div class="row"><button class="primary" id="taskStart">Start</button><span class="small">It runs on this computer in the background; you can close this page.</span></div>
    </section>
    <section aria-labelledby="h-taskask" id="taskAskBox" hidden>
      <h2 id="h-taskask">A task is waiting for your answer</h2>
      <p class="hint">It paused before something it never does unasked — paying, sending, deleting, a password, accepting terms. A yes lets that one action happen, once. No answer in time is a no.</p>
      <div id="taskAsk"></div>
    </section>
    <section aria-labelledby="h-tasklist">
      <h2 id="h-tasklist">Tasks</h2>
      <div id="taskList"></div>
    </section>
    <section id="taskDetail" aria-label="The task you opened" hidden></section>
  </div>

  <div class="set" id="privacy" role="tabpanel" aria-labelledby="tabPrivacy" hidden>
    <section aria-labelledby="h-capture">
      <h2 id="h-capture">Learning what you do <span class="pill" id="capPill">…</span></h2>
      <ul class="plain small mono" id="capLines"></ul>
      <p class="hint">Consent is typed by you: <code>mind observe enable</code> · stop: <code>mind observe disable</code> · delete it all: <code>mind observe purge</code></p>
    </section>
    <section aria-labelledby="h-kept">
      <h2 id="h-kept">Kept on this machine <span class="small" id="keptCount"></span></h2>
      <p class="hint" id="keptGuards"></p>
      <ul class="plain small" id="keptList" style="max-height:55vh;overflow:auto"></ul>
      <p class="hint">Each line is a message the filter or the local judge would not let leave. The words are never recorded — only the rule.</p>
    </section>
    <section aria-labelledby="h-basis">
      <h2 id="h-basis">Why data may come in</h2>
      <ul class="plain" id="basisList"></ul>
      <p class="hint">A basis is recorded in a terminal, by typing a phrase: <code>mind basis record owner --subject <span class="subj"></span> --uses memory,persona</code>. Revoking here stops what comes in next.</p>
    </section>
  </div>

  <div class="set" id="settings" role="tabpanel" aria-labelledby="tabSettings" hidden>
    <section aria-labelledby="h-levels">
      <h2 id="h-levels">What it may do on its own</h2>
      <p class="hint" id="brakeNote" style="display:none;color:hsl(var(--destructive))">The brake is on: nothing runs whatever these say, until you release it in a terminal.</p>
      <div id="cats"></div>
      <p class="hint">“On its own” (3) is only set in a terminal, where you type a phrase: <code>mind autonomy set &lt;category&gt; 3</code></p>
    </section>

    <section aria-labelledby="h-model">
      <h2 id="h-model">Who answers your messages</h2>
      <p class="hint">Used by “Talk to it” on this page, in this browser.</p>
      <div class="field"><label class="small" for="backendSel">Backend</label><select id="backendSel"></select></div>
      <div class="field"><label class="small" for="modelIn">Model (optional)</label><input type="text" id="modelIn" placeholder="e.g. qwen3.8:27b" autocomplete="off"></div>
      <div class="row"><button class="primary" id="saveModel">Save</button><span class="small" id="modelNow"></span></div>
    </section>

    <section aria-labelledby="h-chatusers">
      <h2 id="h-chatusers">People it answers in chat apps</h2>
      <ul class="plain" id="chatUsers"></ul>
      <p class="hint">To add someone, type in a terminal: <code>mind chat allow telegram &lt;user-id&gt; --subject <span class="subj"></span></code></p>
    </section>

    <section aria-labelledby="h-peers">
      <h2 id="h-peers">Agents it talks to</h2>
      <ul class="plain" id="peers"></ul>
      <p class="hint">To add one, type in a terminal: <code>mind a2a allow &lt;name&gt; --endpoint &lt;url&gt; --subject <span class="subj"></span></code></p>
    </section>

    <section aria-labelledby="h-guards">
      <h2 id="h-guards">Privacy guards</h2>
      <ul class="plain" id="guards"></ul>
      <p class="hint">These are set where <code>mind</code> starts, so they cannot be switched from a page.</p>
    </section>

    <section aria-labelledby="h-pair">
      <h2 id="h-pair">Pair a phone</h2>
      <p class="hint">The Mind app reads this page's link — its address and key — from a code. Anyone who scans it can use this page as you, so show it only to your own phone.</p>
      <div class="row"><button id="showPair">Show the code</button><button id="hidePair" hidden>Hide it</button><button id="rotateKey">Unpair every phone</button></div>
      <div id="pairBox" hidden><div id="pairCode" style="width:min(18rem,100%);margin-top:.75rem;background:#fff;border-radius:8px;padding:4px"></div></div>
      <p class="hint">“Unpair every phone” changes this page's key: every paired phone, every other open tab and every saved link stop working. This tab keeps working with the new key.</p>
      <p class="hint" id="pushLine" hidden></p>
    </section>

    <section aria-labelledby="h-version">
      <h2 id="h-version">Version</h2>
      <p id="versionLine"></p>
      <div class="row"><button id="checkUpdate">Check for updates</button><span class="small">Installing is done in a terminal: <code>mind update --yes</code></span></div>
    </section>
  </div>

</main>
</div>
<div class="toast" id="toast" role="status"></div>
<footer class="foot" id="foot"><span><button class="footver" id="footCheck" title="Check for a newer release"><b>Mind</b> <span id="footVer">…</span></button> <span id="footNewer"></span></span><span class="right" id="footWho"></span></footer>
<script>
${MARKDOWN_JS}
// S12.4 — the level-2 change report's own list of what it cannot see
// (REPORT_LIMITS in src/decide/report.ts), inlined so the page needs nothing else.
const CHANGE_LIMITS = ${JSON.stringify([...REPORT_LIMITS])};
(() => {
  const hashParams = new URLSearchParams(location.hash.slice(1));
  document.getElementById("role").addEventListener("click", (e) => e.currentTarget.classList.toggle("open"));
  let token = hashParams.get("t") || webKeep.get(sessionStorage, "mind-t") || "";
  const startTab = hashParams.get("tab") || webKeep.get(sessionStorage, "mind-tab") || "home";
  if (token) { webKeep.set(sessionStorage, "mind-t", token); history.replaceState(null, "", location.pathname); }
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const toast = (text) => { const t = $("toast"); t.textContent = text; t.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = "none", 5200); };
  async function api(path, body) {
    const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "${TOKEN_HEADER}": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) { webKeep.remove(sessionStorage, "mind-t"); $("expired").style.display = "block"; if (!agentName) { $("name").textContent = "Link expired"; $("role").textContent = "Open the full link mind web printed to see your agent."; } throw new Error("expired"); }
    return res.json();
  }
  let canTriage = false;
  let restored = false;
  let lastRecentSig = "";
  let waitAll = false;
  $("keyGo").onclick = () => {
    const raw = $("keyIn").value.trim(); const m = /(?:#t=|^)([0-9a-f]{32,64})/.exec(raw);
    if (!m) { toast("That is not the link or the key — it ends in #t= and a long code."); return; }
    webKeep.set(sessionStorage, "mind-t", m[1]);
    location.replace(location.pathname + "#t=" + m[1]); location.reload();
  };
  $("keyIn").addEventListener("keydown", (e) => { if (e.key === "Enter") $("keyGo").click(); });

  let waitItems = [], waitSig = "";
  const picked = new Set();
  // D-144: the approved suggestions whose turn this page has running. One at a time each: it runs once.
  const runningProposals = new Set();
  // D-144 §2: the spent ones this page is filing again right now. One click, one new suggestion.
  const refilingProposals = new Set();
  // The cards on screen right now. A selection only ever holds these: a bulk "Allow once" must never reach a
  // card that a filter or "Show fewer" has hidden, since the person never saw what it would allow.
  let waitOnScreen = [];
  function waitShown() {
    const q = $("waitFilter").value.trim().toLowerCase(), who = $("waitWho").value;
    return waitItems.filter((p) => (!who || (who === "agent") === p.byAgent) && (!q || (p.what + " " + p.why + " " + p.impact).toLowerCase().includes(q)));
  }
  function renderBulk() {
    for (const id of [...picked]) if (!waitItems.some((p) => p.id === id)) picked.delete(id);
    $("bulkBar").hidden = picked.size === 0;
    $("bulkCount").textContent = picked.size + " selected";
  }
  function renderWaiting(items, force) {
    // Re-render only when something changed: the page polls every few seconds,
    // and a redraw would throw away a note being typed and the selection.
    const sig = JSON.stringify(items.map((p) => [p.id, p.chips.length, p.filed]));
    if (items !== waitItems) waitItems = items;
    if (!force && sig === waitSig) return;
    waitSig = sig;
    const box = $("waiting"); box.replaceChildren();
    const list = waitShown();
    const filtering = $("waitFilter").value.trim() !== "" || $("waitWho").value !== "";
    const shown = waitAll || filtering ? list : list.slice(0, 3);
    waitOnScreen = shown.map((p) => p.id);
    for (const id of [...picked]) if (!waitOnScreen.includes(id)) picked.delete(id);
    $("waitCount").textContent = !items.length ? "" : filtering ? "(" + list.length + " of " + items.length + ")" : "(" + items.length + ")";
    renderBulk();
    if (!items.length) { box.append(el("p", "empty", "Nothing is waiting. You're all caught up.")); return; }
    if (!list.length) { box.append(el("p", "empty", "Nothing matches the filter.")); return; }
    for (const p of shown) {
      const c = el("div", "card");
      const pick = el("label", "pick"); const cb = el("input"); cb.type = "checkbox"; cb.checked = picked.has(p.id); cb.setAttribute("aria-label", "Select: " + p.what);
      cb.onchange = () => { cb.checked ? picked.add(p.id) : picked.delete(p.id); renderBulk(); };
      pick.append(cb); c.append(pick);
      c.append(el("p", "what", p.what));
      c.append(el("p", "meta", "Why: " + p.why));
      c.append(el("p", "meta", "What it affects: " + p.impact));
      c.append(el("p", "meta", (p.byAgent ? "Suggested by the agent" : "Written by you") + " · " + p.filed));
      if (p.chips.length) { const chips = el("div", "chips"); for (const ch of p.chips) chips.append(el("span", "chip " + ch.tone, ch.text)); c.append(chips); }
      const note = el("input"); note.type = "text"; note.placeholder = "Add a note (optional)"; note.setAttribute("aria-label", "Note for this decision");
      const yes = el("button", "primary", "Yes, allow once");
      const no = el("button", "", "No, thanks");
      const busy = (b) => { yes.disabled = no.disabled = b; };
      yes.onclick = async () => { busy(true); const r = await api("/api/proposals/" + p.id + "/approve", { note: note.value }); toast(r.ok ? "Allowed once. Use “Do it now” when you're ready." : (r.message || "That did not work.")); picked.delete(p.id); await refresh(true); };
      no.onclick = async () => { busy(true); const r = await api("/api/proposals/" + p.id + "/refuse", { note: note.value }); toast(r.ok ? "Declined — it won't ask this again unless something changes." : (r.message || "That did not work.")); picked.delete(p.id); await refresh(true); };
      const row = el("div", "row"); row.append(yes, no);
      if (canTriage && !p.chips.length) { const t = el("button", "", "Check risk"); t.title = "Ask TypeSafe's Jev what kind of action this is (sends the text above)"; t.onclick = async () => { t.disabled = true; const r = await api("/api/proposals/" + p.id + "/triage", {}); toast(r.ok ? "Checked." : (r.message || "Could not check.")); await refresh(true); }; row.append(t); }
      c.append(note, row); box.append(c);
    }
    if (!filtering && list.length > 3) {
      const more = el("button", "more", waitAll ? "Show fewer" : "Show all " + list.length);
      more.onclick = () => { waitAll = !waitAll; renderWaiting(waitItems, true); };
      box.append(more);
    }
  }
  $("waitFilter").addEventListener("input", () => renderWaiting(waitItems, true));
  $("waitWho").addEventListener("change", () => renderWaiting(waitItems, true));
  $("waitSelectAll").onclick = () => { for (const id of waitOnScreen) picked.add(id); renderWaiting(waitItems, true); };
  $("bulkClear").onclick = () => { picked.clear(); renderWaiting(waitItems, true); };
  async function bulk(action) {
    const ids = [...picked]; if (!ids.length) return;
    if (action === "refuse" && !confirm("Decline " + ids.length + " suggestion(s)?")) return;
    $("bulkYes").disabled = $("bulkNo").disabled = true;
    let ok = 0;
    for (const id of ids) { const r = await api("/api/proposals/" + id + "/" + action, {}); if (r.ok) { ok++; picked.delete(id); } }
    $("bulkYes").disabled = $("bulkNo").disabled = false;
    toast((action === "approve" ? "Allowed once: " : "Declined: ") + ok + " of " + ids.length);
    await refresh(true);
  }
  $("bulkYes").onclick = () => bulk("approve");
  $("bulkNo").onclick = () => bulk("refuse");
  function renderApproved(items, again, legacy) {
    again = again || []; legacy = legacy || [];
    const box = $("approved"); box.replaceChildren();
    if (items.length) box.append(el("p", "small", "Allowed and not done yet:"));
    for (const p of items) {
      const c = el("div", "card");
      c.append(el("p", "what", p.what), el("p", "meta", "Allowed " + p.decided));
      // D-144: off from the click until the turn comes back — and still off when the poll draws this card again.
      const running = runningProposals.has(p.id);
      const go = el("button", "primary", running ? "Running…" : "Do it now");
      go.disabled = running;
      go.onclick = () => { go.disabled = true; go.textContent = "Running…"; send(p.what, p.id); };
      const row = el("div", "row"); row.append(go, el("span", "small", "Runs once. If it only suggests again, raise “write” to 2 in the terminal."));
      c.append(row); box.append(c);
    }
    // D-144 §2 (the owner, 2026-09-29): an approval a failed turn took stays spent. Only when that turn sent nothing
    // is it offered here — never one that ran or may have. Filing it again asks a new question; nothing runs.
    if (again.length) box.append(el("p", "small", "Allowed, but the turn sent nothing — that approval is used up:"));
    for (const p of again) {
      const c = el("div", "card");
      c.append(el("p", "what", p.what), el("p", "meta", "Nothing was sent" + (p.spent ? " · " + p.spent : "")));
      const busy = refilingProposals.has(p.id);
      const re = el("button", "primary", busy ? "Filing…" : "File it again");
      re.disabled = busy;
      re.onclick = () => refile(p, re);
      const row = el("div", "row"); row.append(re, el("span", "small", "Files it as a new suggestion that waits for your yes. Nothing runs."));
      c.append(row); box.append(c);
    }    // D-153 follow-up: a yes no turn will run — given before approvals named their action, or the record changed
    // after it. A turn refuses it, so it is never offered
    // with "Do it now" — only to be filed again, from its own record, as a new suggestion that waits for a new yes.
    for (const p of legacy) {
      const c = el("div", "card");
      const why = p.reason === "changed" ? "This text changed after your yes. Read it as a new request." : "Approved before approvals named their action — approve it again";
      c.append(el("p", "what", p.what), el("p", "meta", why + (p.approved ? " · allowed " + p.approved : "")));
      const busy = refilingProposals.has(p.id);
      const re = el("button", "primary", busy ? "Filing…" : "File it again for a yes");
      re.disabled = busy;
      re.onclick = () => refile(p, re);
      const row = el("div", "row"); row.append(re, el("span", "small", "Files it as a new suggestion that waits for your yes. Nothing runs, and the old yes is retired."));
      c.append(row); box.append(c);
    }
  }
  async function refile(p, button) {
    if (refilingProposals.has(p.id)) return;
    refilingProposals.add(p.id); button.disabled = true; button.textContent = "Filing…";
    try {
      const r = await api("/api/proposals/" + p.id + "/refile", {});
      toast(r.ok ? "Filed again — it waits for your yes." : (r.message || r.error || "That did not work."));
    } catch { /* the link expired: api() has said so */ }
    finally { refilingProposals.delete(p.id); }
    await refresh(true);
  }
  function renderList(id, items, line, empty) {
    const ul = $(id); ul.replaceChildren();
    if (!items.length) { ul.append(el("li", "empty", empty)); return; }
    for (const it of items) ul.append(line(it));
  }
  async function refresh(force) {
    let s; try { s = await api("/api/state"); } catch { return; }
    lastState = s; canTriage = s.canTriage;
    $("footVer").textContent = s.version ? "v" + s.version.current : "";
    const newer = s.version && s.version.latest && s.version.latest !== s.version.current && s.version.latest.localeCompare(s.version.current, undefined, { numeric: true }) > 0;
    $("footNewer").replaceChildren(...(newer ? [el("span", "newer", "· v" + s.version.latest + " is out — mind update")] : []));
    $("footWho").textContent = s.agent.name + " · " + s.agent.subject + " · on this computer";
    $("name").textContent = s.agent.name; $("role").textContent = s.agent.role; $("role").title = s.agent.role; subject = s.agent.subject; agentName = s.agent.name;
    if (!restored) { restored = true; for (const m of chatLog) bubble(m.cls, m.text, m.small, true, m.info); }
    $("prompt").placeholder = "Ask " + s.agent.name + " a question, or say what you'd like done…";
    document.title = s.agent.name + " · Mind";
    const lv = $("level"); lv.textContent = s.autonomy.title; lv.className = "pill " + s.autonomy.tone;
    $("statusDot").className = "dot " + s.autonomy.tone; $("statusText").textContent = s.autonomy.title;
    renderEngine(s.engine);
    $("levelDetail").textContent = s.autonomy.detail;
    // D-153: the browser, at the level in force — min(operate, reach). English; the Thai follows only when the server was told Thai is chosen (op.th, GL-01).
    const op = s.autonomy.operate; $("operateLine").textContent = op ? "Browser: " + op.title + " — " + op.en + (op.th ? " · " + op.th : "") : "";
    renderWaiting(s.waiting, force === true); renderApproved(s.approved, s.refileable, s.needsReapproval);
    renderTaskAsks(s.taskApprovals);
    $("nextRun").textContent = s.triggers.length ? s.triggers.map((t) => t.id + " · " + t.next).join("  ·  ") : "nothing scheduled";
    renderList("triggers", s.triggers, (t) => { const li = el("li"); li.append(el("div", "", t.id), el("div", "small", "every " + t.every + " · next " + t.next)); return li; }, "No schedule. Add one in soul/triggers.md.");
    const recentSig = JSON.stringify(s.recent.map((r) => [r.id, r.when]));
    if (recentSig !== lastRecentSig) { lastRecentSig = recentSig;
    const openIds = new Set([...document.querySelectorAll("#recent .recentitem.open")].map((x) => x.dataset.id));
    renderList("recent", s.recent, (r) => {
      const li = el("li", "recentitem"); li.dataset.id = r.id; li.tabIndex = 0; li.setAttribute("role", "button"); li.setAttribute("aria-expanded", "false");
      li.append(el("div", "", r.asked), el("div", "small", r.when + " · " + r.backend + (r.ok ? "" : " · no answer")));
      const open = async () => {
        if (li.classList.contains("open")) { li.classList.remove("open"); li.setAttribute("aria-expanded", "false"); li.querySelector(".detail")?.remove(); return; }
        li.classList.add("open"); li.setAttribute("aria-expanded", "true");
        const d = el("div", "detail"); d.onclick = (e) => e.stopPropagation(); d.append(el("div", "small", "Loading…")); li.append(d);
        let t; try { t = await api("/api/turn-detail?id=" + encodeURIComponent(r.id)); } catch { return; }
        d.replaceChildren();
        if (t.error) { d.append(el("div", "small", t.error)); return; }
        if (t.content !== "full") { d.append(el("div", "small", "Only its size was kept for this one — the words were not recorded.")); return; }
        const q = el("div", "notes"); q.textContent = t.asked || ""; d.append(el("div", "small", "Asked"), q);
        const a = el("div", "notes"); a.style.whiteSpace = "normal"; a.append(t.answer ? md(t.answer) : document.createTextNode("(no answer)")); const said = modelLabel(t.model || "", t.modelRequested || ""); d.append(el("div", "small", "Answered by " + t.backend + (said ? " · " + said : "") + " · " + t.when), a);
        const again = el("button", "", "Ask again"); again.onclick = () => { $("prompt").value = t.asked || ""; showTab("home"); $("prompt").focus(); };
        const row = el("div", "row"); row.append(again); d.append(row);
      };
      li.onclick = open; li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
      if (openIds.has(r.id)) setTimeout(open, 0);
      return li;
    }, "Nothing yet — say hello."); }
  }
  let agentName = "";
  let engine = null;
  // S12.4 — the one local rule (src/web/turninfo.ts), written out because this
  // script cannot import it: a backend runs on this machine when its id is
  // ollama or ends in -local. Kept identical to isLocalBackend by tests of both.
  const isLocalId = (id) => id === "ollama" || id.endsWith("-local");
  // D-142 — the model a turn ran on, and apart from it the one it was asked for. A requested name is never shown
  // as the model: claude asked for "opus" and silent about what it ran reads "asked for opus", not "opus".
  const modelLabel = (ran, asked) => ran ? ran + (asked && asked !== ran ? " (asked for " + asked + ")" : "") : (asked ? "asked for " + asked : "");
  function renderEngine(e) {
    if (e) engine = e;
    if (!engine) return;
    const pick = choice();
    const chain = pick.backend ? pick.backend.split(",") : engine.chain;
    // D-142 — a model picked here goes to the one backend picked, or, with the default chain, to its ollama step.
    // A cloud step is only asked for it; a local CLI step runs local-coder whatever is picked.
    const pickFor = (b) => (pick.backend ? pick.backend === b : b === "ollama") ? pick.model : "";
    const box = $("engChain"); box.replaceChildren();
    chain.forEach((b, i) => {
      if (i) box.append(el("i", "", "→"));
      const local = isLocalId(b);
      box.append(el("span", "b" + (local ? " local" : ""), local ? b + " · " + (b === "ollama" ? pickFor(b) || engine.localModel || "no model" : "local-coder") : b + (pickFor(b) ? " · asks for " + pickFor(b) : "")));
    });
    $("engLocal").textContent = pickFor("ollama") || engine.localModel || "not set";
    $("engJudge").textContent = engine.judge ? engine.judge + " (local)" : "off";
    const lastModel = engine.last ? modelLabel(engine.last.model || "", engine.last.modelRequested || "") : "";
    $("engLast").textContent = engine.last ? engine.last.backend + " · " + (isLocalId(engine.last.backend) ? "on this machine" : "cloud") + (lastModel ? " · " + lastModel : "") + " · " + engine.last.when : "—";
    $("engineLine").textContent = "answers: " + chain.join(" → ") + (engine.judge ? " · judge " + engine.judge : "") + (pick.backend || pick.model ? " · this browser's choice" : "");
  }
  // Gap 2 (D-079): the conversation survives a reload — in this browser only.
  const CHAT_KEY = "mind-chat";
  let chatLog = [];
  try { chatLog = JSON.parse(webKeep.get(localStorage, CHAT_KEY) || "[]"); } catch { chatLog = []; }
  function remember(cls, text, small, info) {
    chatLog.push({ cls, text, small: small || "", info: info || null }); chatLog = chatLog.slice(-60);
    webKeep.set(localStorage, CHAT_KEY, JSON.stringify(chatLog));
  }
  $("chatClear").onclick = () => { chatLog = []; webKeep.remove(localStorage, CHAT_KEY); $("chat").replaceChildren(); };
  // S12.4 — the level-2 report of what a turn changed (D-043), as a <details>
  // the answer keeps collapsed. Every value arrives as data from /api/turn and
  // leaves through textContent; a shape that is not the report's renders nothing.
  function changeBlock(report) {
    const d = el("details", "changed");
    const summary = (text) => { const s = el("summary", "", text); d.append(s); return d; };
    if (report === "not-measured") return summary("what it changed: not measured — too many files to check");
    if (report === null || typeof report !== "object") return null;
    const strings = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === "string") : []);
    const added = strings(report.added), modified = strings(report.changed), removed = strings(report.removed);
    if (added.length === 0 && modified.length === 0 && removed.length === 0 && !Array.isArray(report.added)) return null;
    const total = added.length + modified.length + removed.length;
    summary(total === 0 ? "what it changed: nothing" : "what it changed: " + added.length + " added · " + modified.length + " changed · " + removed.length + " removed");
    if (total > 0) {
      const ul = el("ul");
      for (const [mark, paths] of [["+", added], ["~", modified], ["-", removed]]) {
        for (const path of paths.slice(0, 20)) { const li = el("li", "", mark + " " + path); ul.append(li); }
        if (paths.length > 20) ul.append(el("li", "", mark + " … and " + (paths.length - 20) + " more"));
      }
      d.append(ul);
    }
    d.append(el("div", "", "not seen by this report: " + CHANGE_LIMITS.join(" · ")));
    return d;
  }
  function bubble(cls, text, small, restoring, info) {
    if (!restoring) remember(cls, text, small, info);
    const b = el("div", "msg " + cls);
    if (cls === "it" && agentName) b.append(el("div", "small", agentName + " · AI"));
    if (cls === "it" || cls === "sys") { b.style.whiteSpace = "normal"; b.append(md(text)); } else b.append(document.createTextNode(text));
    if (small) b.append(el("div", "small", small));
    if (info && info.changed) { const block = changeBlock(info.changed); if (block) b.append(block); }
    $("chat").append(b); $("chat").scrollTop = 1e9;
    return b;
  }
  // S12.4 — the compact line under an answer: who answered, on this machine or
  // in the cloud, with the model, then what the turn carried that a cloud
  // backend was not allowed to see (D-095). The badge rides on the same rule
  // as the Engine box (isLocalId above); when the answering backend is local
  // nothing was held back from it, so the held counts are cloud-backend facts.
  function turnLine(r, pick) {
    const route = r.route || "";
    if (r.backend === undefined || r.backend === null || r.backend === "") return route;
    if (!/^answered by /.test(route)) return route === "" ? "answered by " + r.backend + " · " + (isLocalId(r.backend) ? "on this machine" : "cloud") : route;
    const local = isLocalId(r.backend);
    // The model the answering backend ran, as the turn reported it (S15.9, D-142). A cloud backend's is what its
    // own output named; the model picked here is only what it was asked for, and is labelled so — never shown as
    // the model. Only a local backend may fall back to what this page knows it runs.
    const model = local ? r.model || (engine && engine.localModel) || pick.model || "" : modelLabel(r.model || "", r.modelRequested || "");
    let line = route.replace(/^answered by [^ ·]+/, "answered by " + r.backend + " · " + (local ? "on this machine" : "cloud") + (model ? " · " + model : ""));
    if (!local && r.held > 0) line += " · " + r.held + " held back";
    if (!local && r.heldMessages > 0) line += " · " + r.heldMessages + " earlier message(s) held back";
    return line;
  }
  async function send(text, proposal) {
    text = (text || "").trim(); if (!text) return;
    if (!proposal && text.startsWith("/")) {
      if (text.startsWith("//")) text = text.slice(1);
      else { $("prompt").value = ""; closeMenu(); await runCommand(text); return; }
    }
    if (proposal) {
      if (runningProposals.has(proposal)) { toast("Already running — it runs once."); return; }
      runningProposals.add(proposal);
    }
    bubble("me", text); $("prompt").value = ""; $("send").disabled = true;
    const minis = ["logo-light", "logo-dark"].map((kind) => { const mini = el("img", kind); mini.src = document.querySelector("." + kind).src; mini.alt = ""; return mini; });
    $("sending").replaceChildren(...minis, document.createTextNode("Thinking…")); document.body.classList.add("thinking");
    try {
      // D-153: an approved action is sent as its id alone — the turn builds the prompt from the record.
      const body = proposal ? { proposal } : { prompt: text };
      // D-095: the last six exchanges of this chat go with it — not the page's own notes, not this message. Not with an approval.
      const talk = chatLog.slice(0, -1).filter((m) => m.cls === "me" || m.cls === "it").slice(-12).map((m) => ({ role: m.cls === "me" ? "you" : "agent", text: m.text.slice(0, 4000) }));
      if (talk.length && !proposal) body.history = talk;
      const pick = choice(); if (pick.backend) body.backend = pick.backend; if (pick.model) body.model = pick.model;
      const r = await api("/api/turn", body);
      if (r.error) bubble("it", r.error);
      else {
        const filed = (r.proposals || []).filter((p) => p.outcome === "filed").length;
        bubble("it", r.text || "(no answer)", turnLine(r, pick) + (filed ? " · " + filed + " suggestion(s) waiting for you" : ""), false, { changed: r.changed });
        // D-144: a turn that did not finish says why — for one under an approval, what became of it. Shown, not dropped.
        if (r.ok === false && r.notes) bubble("sys", r.notes);
      }
    } catch (e) { bubble("it", e && e.message === "expired" ? "This page's link has changed — open the link mind web printed (or the service's key), then send again." : "Could not reach the agent — is mind web still running?"); }
    finally { if (proposal) runningProposals.delete(proposal); }
    $("send").disabled = false; $("sending").replaceChildren(document.createTextNode("Ctrl+Enter to send · / for commands")); document.body.classList.remove("thinking"); refresh();
  }
  // D-085: switch backend and model from the chat. The same two keys Settings writes, so both always agree.
  let models = null;
  function pickSummary() {
    const p = choice();
    const who = p.backend || (models ? models.chain.join(" → ") : "default");
    $("chatPick").replaceChildren(document.createTextNode("▾ "), el("b", "", who), document.createTextNode(p.model ? " · " + p.model : ""));
  }
  // D-142 — which backend a model typed here goes to: the one picked, or with the default chain its ollama step
  // (a bare --model in a chain of several is ollama's; it never reaches a vendor CLI there).
  const modelTargets = (backend) => backend ? [backend] : (models && models.chain.includes("ollama") ? ["ollama"] : []);
  function fillModelList() {
    const p = choice(); const list = $("chatModelList"); list.replaceChildren();
    if (!models) return;
    const ids = modelTargets(p.backend);
    for (const name of [...new Set(ids.flatMap((b) => models.models[b] || []))]) { const o = el("option"); o.value = name; list.append(o); }
    $("chatModel").placeholder = "Model — blank for " + (p.backend === "ollama" || (!p.backend && models.defaultTurn.model) ? (models.defaultTurn.model || engine && engine.localModel || "its default") : "its default");
  }
  function syncPicker() {
    const p = choice();
    if (models) {
      const sel = $("chatBackend"); sel.replaceChildren();
      const def = el("option", "", "Default — " + models.chain.join(" → ")); def.value = ""; sel.append(def);
      for (const b of models.backends) { const o = el("option", "", b.id + (b.available ? "" : " — not on this computer")); o.value = b.id; o.disabled = !b.available && b.id !== p.backend; sel.append(o); }
      sel.value = p.backend; if (sel.value !== p.backend) sel.value = "";
    }
    $("chatModel").value = p.model; fillModelList(); pickSummary(); renderEngine();
    if ($("backendSel").options.length) { $("backendSel").value = p.backend; $("modelIn").value = p.model; showModelNow(); }
  }
  async function loadModels() { try { models = await api("/api/models"); } catch { return; } syncPicker(); }
  $("chatPick").onclick = () => {
    const open = $("pickRow").hidden; $("pickRow").hidden = !open; $("chatPick").setAttribute("aria-expanded", String(open));
    if (open) { if (!models) loadModels(); $("chatBackend").focus(); }
  };
  $("chatBackend").addEventListener("change", () => {
    const backend = $("chatBackend").value, model = $("chatModel").value.trim();
    store.set("mind-backend", backend);
    // A model named for another backend would fail here (qwen on claude): clear it rather than send a turn that cannot work.
    if (model && models) {
      const mine = modelTargets(backend).some((b) => (models.models[b] || []).includes(model));
      const theirs = Object.keys(models.models).find((b) => (models.models[b] || []).includes(model));
      if (!mine && theirs) { store.set("mind-model", ""); toast("Model cleared — " + model + " is for " + theirs + "."); }
    }
    syncPicker();
  });
  $("chatModel").addEventListener("change", () => { store.set("mind-model", $("chatModel").value.trim()); syncPicker(); });
  $("chatModel").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("chatModel").dispatchEvent(new Event("change")); $("prompt").focus(); } });
  // D-086: "/" commands — every one is something this page can already do, typed instead of clicked.
  let lastState = null;
  function sys(text, actions) {
    const b = bubble("sys", text);
    if (actions && actions.length) {
      const row = el("div", "row");
      for (const a of actions) { const btn = el("button", a.primary ? "primary" : (a.danger ? "danger" : ""), a.label); btn.onclick = async () => { row.querySelectorAll("button").forEach((x) => x.disabled = true); await a.run(); }; row.append(btn); }
      b.append(row);
    }
    return b;
  }
  const LEVEL_WORDS = { never: 0, "0": 0, ask: 1, "1": 1, tell: 2, then: 2, "2": 2 };
  function waitingRef(ref) {
    const items = (lastState && lastState.waiting) || [];
    if (!ref) return { error: "Say which: a number from /waiting, or the start of its id." };
    const n = Number(ref);
    if (Number.isInteger(n) && n >= 1 && n <= items.length && String(n) === ref) return { item: items[n - 1] };
    const hits = ref.length >= 4 ? items.filter((p) => p.id.startsWith(ref.toLowerCase())) : [];
    if (hits.length === 1) return { item: hits[0] };
    return { error: hits.length > 1 ? "More than one starts with " + ref + " — type more of it." : "Nothing waiting is " + ref + ". /waiting lists them." };
  }
  function approvedRef(ref) {
    const items = (lastState && lastState.approved) || [];
    const n = Number(ref);
    if (Number.isInteger(n) && n >= 1 && n <= items.length && String(n) === ref) return items[n - 1];
    const hits = ref && ref.length >= 4 ? items.filter((p) => p.id.startsWith(ref.toLowerCase())) : [];
    return hits.length === 1 ? hits[0] : null;
  }
  function slugOf(text) { let out = ""; for (const ch of text.toLowerCase()) out += (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") ? ch : "-"; return out.split("-").filter(Boolean).slice(0, 7).join("-").slice(0, 50); }
  const TAB_NAMES = ["home", "agent", "profile", "memories", "privacy", "settings"];
  const COMMANDS = [
    { name: "help", args: "[command]", help: "What each command does", run: (a) => {
      const one = COMMANDS.find((c) => c.name === a.replace("/", ""));
      if (one) return sys("**/" + one.name + (one.args ? " " + one.args : "") + "** — " + one.help + (one.more ? "\\n\\n" + one.more : ""));
      sys("**Commands** — type / to pick one. Start a message with // to send a slash as text.\\n\\n" + COMMANDS.map((c) => "- **/" + c.name + "**" + (c.args ? " " + c.args : "") + " — " + c.help).join("\\n"));
    } },
    { name: "clear", args: "", help: "Clear this browser's copy of the conversation", run: () => { $("chatClear").click(); } },
    { name: "retry", args: "", help: "Send your last message again", run: () => {
      const last = [...chatLog].reverse().find((m) => m.cls === "me");
      if (!last) return sys("Nothing to send again yet."); return send(last.text);
    } },
    { name: "copy", args: "", help: "Copy the last answer", run: async () => {
      const last = [...chatLog].reverse().find((m) => m.cls === "it");
      if (!last) return sys("No answer to copy yet.");
      try { await navigator.clipboard.writeText(last.text); toast("Copied the last answer."); } catch { sys("This browser would not let the page copy — select the text instead."); }
    } },
    { name: "export", args: "", help: "Save the conversation as a Markdown file", run: () => {
      if (!chatLog.length) return sys("Nothing to save yet.");
      const lines = chatLog.map((m) => (m.cls === "me" ? "**You:** " : m.cls === "it" ? "**" + (agentName || "Agent") + ":** " : "_Page:_ ") + m.text + (m.small ? "\\n\\n_" + m.small + "_" : ""));
      const a = el("a"); a.href = URL.createObjectURL(new Blob(["# " + (agentName || "Agent") + " — conversation\\n\\n" + lines.join("\\n\\n---\\n\\n") + "\\n"], { type: "text/markdown" }));
      a.download = (agentName || "agent") + "-chat-" + new Date().toISOString().slice(0, 10) + ".md"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } },
    { name: "backend", args: "[name|default]", help: "Switch who answers (as the picker under the box does)", run: async (a) => {
      if (!models) await loadModels();
      const ids = models ? models.backends.map((b) => b.id) : [];
      if (!a) { const p = choice(); return sys("Answering: **" + (p.backend || "default (" + (models ? models.chain.join(" → ") : "…") + ")") + "**" + (p.model ? " · " + p.model : "") + "\\n\\nBackends: " + (models ? models.backends.map((b) => b.id + (b.available ? "" : " (not here)")).join(", ") : "…") + "\\n\\n/backend <name> to switch, /backend default to go back."); }
      const want = a === "default" ? "" : a.toLowerCase();
      if (want && !ids.includes(want)) return sys("No backend called " + a + ". These are: " + ids.join(", ") + ".");
      if (want && !models.backends.find((b) => b.id === want).available) return sys(want + " is not on this computer.");
      $("chatBackend").value = want; $("chatBackend").dispatchEvent(new Event("change"));
      sys("Now answering: **" + (want || "default") + "**" + (choice().model ? " · " + choice().model : ""));
    } },
    { name: "model", args: "[name|default]", help: "Switch the model the backend uses", run: async (a) => {
      if (!models) await loadModels();
      const p = choice(), ids = p.backend ? [p.backend] : (models ? models.chain : []);
      const sugg = models ? [...new Set(ids.flatMap((b) => models.models[b] || []))] : [];
      if (!a) return sys("Model: **" + (p.model || "the backend's default") + "**" + (sugg.length ? "\\n\\nSuggested here: " + sugg.join(", ") : "") + "\\n\\n/model <name> to switch, /model default to clear.");
      store.set("mind-model", a === "default" ? "" : a); syncPicker();
      sys("Model: **" + (choice().model || "the backend's default") + "**" + (a !== "default" && sugg.length && !sugg.includes(a) ? " — not one this backend has answered with before; the next message will tell." : ""));
    } },
    { name: "status", args: "", help: "How the agent stands right now", run: async () => {
      await refresh(true); const s = lastState; if (!s) return sys("The agent did not answer.");
      const p = choice();
      sys("**" + s.agent.name + "** — " + s.autonomy.title + "\\n\\n- Waiting for you: " + s.waiting.length + "\\n- Allowed, not done yet: " + s.approved.length + "\\n- Answers: " + (p.backend || s.engine.chain.join(" → ")) + (p.model ? " · " + p.model : "") + "\\n- Judge: " + (s.engine.judge || "off") + "\\n- Last answered by: " + (s.engine.last ? s.engine.last.backend + " · " + s.engine.last.when : "—") + "\\n- Next scheduled: " + (s.triggers.length ? s.triggers.map((t) => t.id + " " + t.next).join(", ") : "nothing"));
    } },
    { name: "waiting", args: "", help: "List what waits for your yes, numbered", run: async () => {
      await refresh(true); const w = (lastState && lastState.waiting) || [], ok = (lastState && lastState.approved) || [];
      if (!w.length && !ok.length) return sys("Nothing is waiting. You're all caught up.");
      sys((w.length ? "**Waiting for you**\\n\\n" + w.map((p, i) => (i + 1) + ". " + p.what + " — _" + p.id.slice(0, 8) + " · " + (p.byAgent ? "by the agent" : "by you") + " · " + p.filed + "_").join("\\n") + "\\n\\n/approve <number> or /decline <number>" : "") + (ok.length ? "\\n\\n**Allowed, not done yet**\\n\\n" + ok.map((p, i) => (i + 1) + ". " + p.what + " — _" + p.id.slice(0, 8) + "_").join("\\n") + "\\n\\n/do <number> runs one" : ""));
    } },
    { name: "approve", args: "<number|id> [note]", help: "Allow one suggestion, once", run: async (a) => {
      const [ref, ...note] = a.split(" "); const r = waitingRef(ref); if (r.error) return sys(r.error);
      const out = await api("/api/proposals/" + r.item.id + "/approve", { note: note.join(" ") });
      sys(out.ok ? "Allowed once: **" + r.item.what + "** — /do when you're ready." : (out.message || "That did not work.")); refresh(true);
    } },
    { name: "decline", args: "<number|id> [note]", help: "Decline one suggestion", run: async (a) => {
      const [ref, ...note] = a.split(" "); const r = waitingRef(ref); if (r.error) return sys(r.error);
      const out = await api("/api/proposals/" + r.item.id + "/refuse", { note: note.join(" ") });
      sys(out.ok ? "Declined: **" + r.item.what + "**" : (out.message || "That did not work.")); refresh(true);
    } },
    { name: "do", args: "<number|id>", help: "Run something already allowed, once", run: async (a) => {
      await refresh(true); const p = approvedRef(a.trim());
      if (!p) return sys(((lastState && lastState.approved) || []).length ? "Say which: a number from /waiting's “allowed” list." : "Nothing allowed is waiting to be done.");
      return send(p.what, p.id);
    } },
    { name: "search", args: "[knowledge|memory] <question>", help: "Ask memory — a short answer with its sources, the way Search by meaning does (or one kind only)", run: async (a) => {
      if (!a) return sys("Ask what? /search [knowledge|memory] <question>");
      const first = a.split(" ")[0].toLowerCase(), scope = first === "knowledge" || first === "memory" ? first : "all";
      const words = scope === "all" ? a : a.slice(first.length).trim();
      if (!words) return sys("Ask " + scope + " what?");
      sys("Searching your memory…");
      let r; try { r = await api("/api/memory-ask", { question: words, scope }); } catch { r = { ok: false, error: "The server did not answer." }; }
      sys("**" + (scope === "knowledge" ? "Knowledge" : scope === "memory" ? "Memory (not knowledge)" : "Memory") + " — " + words + "**\\n\\n" + askSaid(r));
    } },
    { name: "remember", args: "<text>", help: "Save a note to memory (as New memory does)", more: "Goes to memory/notes/<date>-<words>.md through mind memory write: the credential scan and the memory basis apply.", run: async (a) => {
      if (!a) return sys("Remember what? /remember <text>");
      const day = new Date().toISOString().slice(0, 10), slug = slugOf(a) || "note-" + new Date().toISOString().slice(11, 19).split(":").join("");
      const path = "memory/notes/" + day + "-" + slug + ".md", title = a.split("\\n")[0].slice(0, 70);
      const text = "---\\nname: " + JSON.stringify(title) + "\\ndescription: " + JSON.stringify(a.split("\\n").join(" ").slice(0, 150)) + "\\nmetadata:\\n  type: project\\n---\\n\\n" + a + "\\n";
      const r = await api("/api/memory/write", { path, content: text });
      sys(r.ok ? "Remembered in **" + path + "**. " + (r.message || "").split("\\n").slice(1, 2).join("") : "Not saved — " + (r.message || r.error || "that did not work."));
      if (r.ok && !$("memories").hidden) loadMemories();
    } },
    { name: "import", args: "<link>", help: "Bring a web page into memory (shows first)", run: async (a) => {
      if (!a) return sys("Import which link? /import https://…");
      const plan = await api("/api/memory/import", { url: a });
      if (!plan.ok) return sys("Cannot import it — " + (plan.message || plan.error || "no reason given."));
      sys("**Import " + a + "?**\\n\\n" + plan.message, [
        { label: "Import it", primary: true, run: async () => { const r = await api("/api/memory/import", { url: a, write: true }); sys(r.ok ? "Imported. " + (r.message || "").split("\\n").filter((l) => l.startsWith("imported")).join("") : "Not imported — " + (r.message || r.error || "")); } },
        { label: "Cancel", run: async () => sys("Nothing was imported.") },
      ]);
    } },
    { name: "who", args: "<port|service|host|env|path>", help: "Which memories mention it — “/who 10410”", run: async (a) => {
      if (!a) return sys("Who mentions what? /who 10410, /who mind-web-om.service, /who ~/ai-stack");
      const hits = await api("/api/memory/who?q=" + encodeURIComponent(a));
      if (!hits.length) return sys("Nothing in memory mentions **" + a + "**.");
      sys(hits.map((h) => "**" + h.type + " " + h.value + "** — " + h.mentions.length + "\\n\\n" + h.mentions.map((m) => "- " + m.title + " — _" + m.path + ":" + m.line + "_").join("\\n")).join("\\n\\n"));
    } },
    { name: "facts", args: "", help: "Open the facts waiting for your yes or no (drawn out of memory)", run: () => { showTab("memories"); $("h-facts").scrollIntoView({ block: "start" }); } },
    { name: "tags", args: "", help: "List the collections, with how many memories are in each", run: async () => {
      if (!mems.length) { try { mems = await api("/api/memories"); } catch { return; } }
      const count = new Map(); for (const m of mems) for (const t of m.tags || []) count.set(t, (count.get(t) || 0) + 1);
      if (!count.size) return sys("No collections yet. Tag a memory: open it in Memories → Edit tags, or /tag <name>.");
      sys("**Collections**\\n\\n" + [...count].sort((a, b) => b[1] - a[1]).map(([t, n]) => "- #" + t + " — " + n).join("\\n") + "\\n\\n/tag <name> opens one.");
    } },
    { name: "tag", args: "<name>", help: "Open one collection in Memories", run: async (a) => {
      const t = a.trim().toLowerCase().replace(/^#/, ""); if (!t) return sys("Which collection? /tags lists them.");
      showTab("memories"); memTag = t; if (mems.length) { drawTags(); drawMemories(); }
    } },
    { name: "memories", args: "[words]", help: "Open Memories, filtered by words", run: (a) => { showTab("memories"); $("memFilter").value = a; if (mems.length) drawMemories(); } },
    { name: "autonomy", args: "[read|write|run|reach|operate] [never|ask|tell]", help: "See or set what it may do on its own", more: "Levels here go up to “do it, then tell me” (2). Acting without asking (3) is typed in a terminal.", run: async (a) => {
      const [cat, lvl] = a.toLowerCase().split(" ").filter(Boolean);
      if (!cat) { const st = await api("/api/settings"); return sys("**What it may do on its own**\\n\\n" + CATS.map(([k, name]) => "- " + name + ": " + (st.levels[k] === 3 ? (k === "operate" ? "any site" : "on its own") : wordsFor(k)[st.levels[k]] || st.levels[k])).join("\\n") + (st.operate ? "\\n\\nBrowser now: " + st.operate.en + (st.operate.th ? " · " + st.operate.th : "") : "") + "\\n\\n/autonomy <read|write|run|reach|operate> <never|ask|tell>"); }
      const known = CATS.find(([k]) => k === cat); if (!known) return sys("The kinds are read, write, run, reach and operate.");
      if (!(lvl in LEVEL_WORDS)) return sys("The levels are never, ask and tell (0, 1, 2).");
      const r = await api("/api/autonomy", { category: cat, level: LEVEL_WORDS[lvl] });
      sys(r.ok ? known[1] + ": **" + wordsFor(cat)[LEVEL_WORDS[lvl]].toLowerCase() + "**." : (r.message || r.error || "That did not work.")); refresh(true);
    } },
    { name: "stop", args: "", help: "Pull the brake — the same as Stop everything", run: () => { $("stopBtn").click(); } },
    { name: "update", args: "", help: "Check for a newer mind", run: async () => { const r = await api("/api/update-check", {}); sys(r.message || (r.ok ? "Checked." : "Could not check.")); } },
    { name: "go", args: "<home|agent|profile|memories|privacy|settings>", help: "Open a section", run: (a) => { const t = a.toLowerCase(); if (!TAB_NAMES.includes(t)) return sys("The sections are " + TAB_NAMES.join(", ") + "."); showTab(t); } },
    ...["agent", "profile", "privacy", "settings"].map((t) => ({ name: t, args: "", help: "Open " + t[0].toUpperCase() + t.slice(1), run: () => showTab(t) })),
  ];
  async function runCommand(text) {
    const body = text.slice(1); const space = body.search(" ");
    const name = (space < 0 ? body : body.slice(0, space)).toLowerCase(), arg = space < 0 ? "" : body.slice(space + 1).trim();
    const cmd = COMMANDS.find((c) => c.name === name);
    if (!cmd) { sys("No command /" + name + ". /help lists them — or start with // to send it as a message."); return; }
    try { await cmd.run(arg); } catch (e) { if (!(e && e.message === "expired")) sys("/" + name + " did not finish — " + (e && e.message ? e.message : "something went wrong.")); }
  }
  // The menu: opens on "/", narrows as you type the name, ↑ ↓ to move, Tab or Enter to take, Esc to close.
  let menuAt = 0, menuHits = [];
  function closeMenu() { $("cmdMenu").hidden = true; menuHits = []; }
  function drawMenu() {
    const v = $("prompt").value;
    if (!v.startsWith("/") || v.startsWith("//") || v.includes(" ") || v.includes("\\n")) { closeMenu(); return; }
    const q = v.slice(1).toLowerCase();
    menuHits = COMMANDS.filter((c) => c.name.startsWith(q)).concat(COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q)));
    if (!menuHits.length) { closeMenu(); return; }
    menuAt = Math.min(menuAt, menuHits.length - 1);
    const box = $("cmdMenu"); box.replaceChildren();
    menuHits.forEach((c, i) => {
      const b = el("button"); b.type = "button"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(i === menuAt));
      b.append(el("b", "", "/" + c.name + (c.args ? " " + c.args : "")), el("span", "small", c.help));
      b.onmousedown = (e) => { e.preventDefault(); menuAt = i; takeMenu(); };
      box.append(b);
    });
    box.hidden = false; box.children[menuAt].scrollIntoView({ block: "nearest" });
  }
  function takeMenu() {
    const c = menuHits[menuAt]; if (!c) return;
    closeMenu();
    // No arguments, or the whole name typed with only optional ones: run it now. Otherwise leave "/name " for the rest.
    const typed = $("prompt").value.trim().toLowerCase();
    if (!c.args || (typed === "/" + c.name && c.args.startsWith("["))) { send("/" + c.name); return; }
    $("prompt").value = "/" + c.name + " "; $("prompt").focus();
  }
  $("prompt").addEventListener("input", () => { menuAt = 0; drawMenu(); });
  $("prompt").addEventListener("blur", () => setTimeout(closeMenu, 150));
  $("prompt").addEventListener("keydown", (e) => {
    if ($("cmdMenu").hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); menuAt = (menuAt + (e.key === "ArrowDown" ? 1 : -1) + menuHits.length) % menuHits.length; drawMenu(); }
    else if ((e.key === "Enter" && !(e.ctrlKey || e.metaKey)) || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); takeMenu(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
  });
  // A finished command sends on plain Enter too — a one-line command is not a paragraph.
  $("prompt").addEventListener("keydown", (e) => {
    const v = $("prompt").value;
    if (e.key === "Enter" && !e.shiftKey && !(e.ctrlKey || e.metaKey) && $("cmdMenu").hidden && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\n")) { e.preventDefault(); send(v); }
  });
  $("footCheck").onclick = async () => { const r = await api("/api/update-check", {}); toast(r.message || (r.ok ? "Checked." : "Could not check.")); refresh(); };
  $("send").onclick = () => send($("prompt").value);
  $("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send($("prompt").value); });
  $("stopBtn").onclick = async () => {
    if (!confirm("Stop everything?\\n\\nRunning work is ended and it may do nothing on its own until you release the brake in a terminal.")) return;
    const r = await api("/api/stop", {}); toast(r.ok ? "Stopped. Nothing will run until you release the brake." : (r.message || "Some things could not be stopped — see the terminal.")); refresh();
  };

  // ── Settings ──
  const store = { get(k) { return webKeep.get(localStorage, k) || ""; }, set(k, v) { if (v) webKeep.set(localStorage, k, v); else webKeep.remove(localStorage, k); } };
  function choice() { return { backend: store.get("mind-backend"), model: store.get("mind-model") }; }
  const CATS = [["read", "Read", "look at files and folders"], ["write", "Write", "change or create files"], ["run", "Run", "run commands on this computer"], ["reach", "Reach", "contact other services and agents"], ["operate", "Browser", "use a web browser for you"]];
  const LEVELS = ["Never", "Ask me first", "Do it, then tell me"];
  // D-153: the browser's own words. 3 (any site) is typed in a terminal, like every 3.
  const OP_LEVELS = ["No browser", "Looks and suggests", "Allowed sites only"];
  const wordsFor = (key) => key === "operate" ? OP_LEVELS : LEVELS;
  const TABS = ["home", "agent", "profile", "memories", "tasks", "privacy", "settings"];
  function showTab(which) {
    if (!TABS.includes(which)) which = "home";
    for (const t of TABS) {
      $(t).hidden = t !== which;
      const tabEl = $("tab" + t[0].toUpperCase() + t.slice(1));
      tabEl.setAttribute("aria-selected", String(t === which));
      tabEl.tabIndex = t === which ? 0 : -1;
    }
    document.querySelector("main").classList.toggle("homeon", which === "home");
    webKeep.set(sessionStorage, "mind-tab", which);
    if (which === "settings") loadSettings();
    if (which === "agent") loadAgent();
    if (which === "memories") loadMemories();
    if (which === "profile") { loadProfile(); loadDrafts(); }
    if (which === "privacy") loadPrivacy();
    if (which === "tasks") loadTasks();
  }
  for (const t of TABS) $("tab" + t[0].toUpperCase() + t.slice(1)).onclick = () => showTab(t);
  // Tabs (spec §5): one stop in the tab order, the arrows (and Home, End) move between them and select as they go.
  const tabAt = (i) => $("tab" + TABS[i][0].toUpperCase() + TABS[i].slice(1));
  document.querySelector("nav.tabs").addEventListener("keydown", (e) => {
    const now = TABS.findIndex((t) => tabAt(TABS.indexOf(t)) === document.activeElement);
    if (now < 0) return;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (now + 1) % TABS.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (now + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault(); showTab(TABS[to]); tabAt(to).focus();
  });
  // The theme (spec §6): System, Light, Dark, in that order on a press. Kept on this device; System follows the device live.
  const THEMES = ["system", "light", "dark"], THEME_WORDS = { system: "System", light: "Light", dark: "Dark" };
  let theme = "system"; { const kept = webKeep.get(localStorage, "mind-theme"); if (THEMES.includes(kept)) theme = kept; }
  function drawTheme(say) {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme);
    const b = $("themeBtn"); b.dataset.state = theme; b.setAttribute("aria-label", "Theme: " + THEME_WORDS[theme]); $("themeLabel").textContent = THEME_WORDS[theme];
    for (const svg of b.querySelectorAll("svg")) svg.classList.toggle("shown", svg.dataset.for === theme);
    if (say) $("themeStatus").textContent = "Theme: " + THEME_WORDS[theme];
  }
  $("themeBtn").onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; if (theme === "system") webKeep.remove(localStorage, "mind-theme"); else webKeep.set(localStorage, "mind-theme", theme); drawTheme(true); };
  drawTheme(false);
  const kv = (id, rows) => { const dl = $(id); dl.replaceChildren(); for (const [k, v] of rows) { if (v === null || v === undefined || v === "") continue; const dd = el("dd"); if (v instanceof Node) dd.append(v); else dd.textContent = v; dl.append(el("dt", "", k), dd); } };
  async function loadAgent() {
    let a; try { a = await api("/api/agent"); } catch { return; }
    const probs = $("agentProblems"); probs.style.display = a.ok ? "none" : "block"; probs.textContent = a.ok ? "" : "Its soul does not load: " + a.problems.join(" · ") + " — run mind soul check in a terminal.";
    kv("whoKv", [["Name", a.name], ["Its job", a.role], ["Subject", a.subject], ["Folder", a.dir]]);
    let remote = "none — this repository is only on this computer";
    if (a.repo.remote) { if (a.repo.web) { const link = el("a", "", a.repo.remote); link.href = a.repo.web; link.target = "_blank"; link.rel = "noopener noreferrer"; remote = link; } else remote = a.repo.remote; }
    kv("repoKv", [["Where", a.dir], ["Remote", remote], ["Latest", a.repo.head ? a.repo.head + (a.repo.lastCommit ? " — " + a.repo.lastCommit : "") + (a.repo.lastCommitAt ? " (" + a.repo.lastCommitAt + ")" : "") : "no commits yet"]]);
    kv("scopeKv", [["Does", a.scope.does], ["Does not", a.scope.doesNot]]);
    renderList("prohibitions", a.prohibitions, (p) => el("li", "", p), "No prohibitions listed.");
    const p = a.person;
    kv("personKv", p ? [["Calls you", p.addressesUserAs], ["Calls itself", p.refersToSelfAs.join(", ")], ["Tone", p.tone.join(", ")], ["Knowledge from", p.inheritsFrom.join(", ")]] : []);
    renderList("principles", p ? p.principles : [], (x) => el("li", "", x), "None listed.");
    const st = $("stats"); st.replaceChildren();
    const stat = (n, label) => { const d = el("span", "stat"); d.append(el("b", "", String(n)), el("span", "small", label)); st.append(d); };
    stat(a.stats.memories, "memories"); stat(a.stats.turns, "records in the ledger"); stat(a.stats.lastTurn || "—", "last one");
    renderList("byBackend", a.stats.byBackend, (b) => el("li", "", b.backend + " — " + b.turns), "Nothing recorded yet.");
    for (const [id, text] of [["roleNotes", a.roleNotes], ["personNotes", a.personNotes]]) { const box = $(id); box.replaceChildren(); box.style.whiteSpace = "normal"; box.append(text ? md(text) : document.createTextNode("(empty)")); }
  }

  // ── Profile wizard (D-074) ──
  const WIZ = [
    { title: "Identity", fields: [["name", "text", "Its name", "What people call it. Never the name of a real person it learned from."], ["role", "area", "Its job", "One sentence: what it is for."]] },
    { title: "Scope", fields: [["does", "area", "What it does", "The work that is its job."], ["doesNot", "area", "What it does not do", "Where its job stops."]] },
    { title: "Never", fields: [["prohibitions", "list", "It never…", "One per line. At least one."]] },
    { title: "Voice", fields: [["tone", "list", "Tone", "A word or two per line — plain, warm, brief…"], ["addressesUserAs", "text", "What it calls you", ""], ["refersToSelfAs", "list", "What it calls itself", "One per line."]] },
    { title: "Principles", fields: [["principles", "list", "How it works", "One per line."]] },
    { title: "Knowledge from", fields: [["inheritsFrom", "list", "Whose knowledge it carries", "People whose work it learned from, one per line. These names are personal: they stay in person.md, are screened from anything that leaves, and can never be its own name."]] },
    { title: "Autonomy", autonomy: true },
    { title: "Notes", fields: [["roleNotes", "long", "About the job (role.md)", "Markdown. Knowledge that belongs to the job, not the person."], ["personNotes", "long", "About the person (person.md)", "Markdown. Voice and manner only."]] },
    { title: "Review", review: true },
  ];
  let wizStep = 0, wizDraft = null, wizOrig = null, wizLevels = null, wizLevelsOrig = null;
  const toLines = (v) => v.split("\\n").map((x) => x.trim()).filter(Boolean);
  function wizCollect() {
    for (const f of (WIZ[wizStep].fields || [])) {
      const input = document.getElementById("wiz-" + f[0]); if (!input) continue;
      wizDraft[f[0]] = f[1] === "list" ? toLines(input.value) : f[1] === "text" ? input.value.trim() : input.value;
    }
  }
  function wizRender() {
    const nav = $("wizSteps"); nav.replaceChildren();
    WIZ.forEach((st, i) => { const b = el("button", i < wizStep ? "done" : "", (i + 1) + ". " + st.title); if (i === wizStep) b.setAttribute("aria-current", "step"); b.onclick = () => { wizCollect(); wizStep = i; wizRender(); }; nav.append(b); });
    const body = $("wizBody"); body.replaceChildren(); $("wizNote").textContent = "";
    const st = WIZ[wizStep];
    for (const f of (st.fields || [])) {
      const [key, kind, label, hint] = f;
      const l = el("label", "", label); l.htmlFor = "wiz-" + key; body.append(l);
      if (hint) body.append(el("p", "hint", hint));
      const input = kind === "text" ? el("input") : el("textarea", kind === "long" ? "long" : "");
      if (kind === "text") input.type = "text";
      input.id = "wiz-" + key;
      const v = wizDraft[key]; input.value = Array.isArray(v) ? v.join("\\n") : (v || "");
      body.append(input);
    }
    if (st.autonomy) {
      body.append(el("p", "hint", "What it may do without asking. “On its own” (3) is only set in a terminal, with a typed phrase."));
      for (const [key, name, what] of CATS) {
        const row = el("div", "cat"); const label = el("div"); label.append(el("div", "what", name), el("div", "small", "May it " + what + "?"));
        const seg = el("div", "seg");
        wordsFor(key).forEach((word, level) => { const b = el("button", "", word); b.setAttribute("aria-pressed", String(wizLevels[key] === level)); b.onclick = () => { wizLevels[key] = level; wizRender(); }; seg.append(b); });
        const right = el("div"); right.append(seg); if (wizLevels[key] === 3) right.append(el("span", "lock", "now 3 — lowering it here is fine"));
        row.append(label, right); body.append(row);
      }
    }
    if (st.review) {
      const changedLv = CATS.filter(([k]) => wizLevels[k] !== wizLevelsOrig[k]).map(([k, n]) => n + " → " + wordsFor(k)[wizLevels[k]]);
      const box = el("div", "notes"); box.textContent = "Checking…"; body.append(box);
      api("/api/profile", { profile: wizDraft, write: false }).then((r) => {
        const lines = [r.ok ? (r.message || "") : "Not saveable yet:\\n" + (r.problems || r.message || "")];
        if (changedLv.length) lines.push("autonomy: " + changedLv.join(", "));
        box.textContent = lines.filter(Boolean).join("\\n") || "Nothing changes.";
        $("wizNext").disabled = !r.ok && !changedLv.length;
      }).catch(() => { box.textContent = "Could not check."; });
    }
    $("wizBack").disabled = wizStep === 0;
    $("wizNext").disabled = false;
    $("wizNext").textContent = st.review ? "Save" : "Next";
  }
  async function loadProfile() {
    let p; try { p = await api("/api/profile"); } catch { return; }
    if (!p.ok) { $("wizBody").textContent = "The soul does not load: " + p.reason; return; }
    let s; try { s = await api("/api/settings"); } catch { return; }
    wizOrig = p.profile; wizDraft = JSON.parse(JSON.stringify(p.profile));
    wizLevelsOrig = Object.assign({}, s.levels); wizLevels = Object.assign({}, s.levels);
    wizStep = 0; wizRender();
  }
  $("wizBack").onclick = () => { wizCollect(); if (wizStep > 0) { wizStep--; wizRender(); } };
  $("wizNext").onclick = async () => {
    wizCollect();
    if (!WIZ[wizStep].review) { wizStep++; wizRender(); return; }
    $("wizNext").disabled = true; $("wizNote").textContent = "Saving…";
    const notes = [];
    const r = await api("/api/profile", { profile: wizDraft, write: true });
    if (r.ok) notes.push(r.message); else if (!/Nothing differs/.test(r.message || "")) notes.push("Soul not saved: " + (r.problems || r.message));
    for (const [key, name] of CATS) {
      if (wizLevels[key] === wizLevelsOrig[key] || wizLevels[key] > 2) continue;
      const a = await api("/api/autonomy", { category: key, level: wizLevels[key] });
      notes.push(a.ok ? name + " set to " + wordsFor(key)[wizLevels[key]] : (a.message || a.error || name + " not set"));
    }
    toast(notes.filter(Boolean).join("\\n") || "Nothing to save.");
    await refresh(); await loadProfile();
  };
  async function loadPrivacy() {
    let p; try { p = await api("/api/privacy"); } catch { return; }
    const pill = $("capPill"); pill.textContent = p.capture.on ? "on" : "off"; pill.className = "pill " + (p.capture.on ? "act" : "stop");
    renderList("capLines", p.capture.lines, (l) => el("li", "", l), "No record of it for this subject.");
    $("keptCount").textContent = p.keptInTotal ? "(" + p.keptInTotal + ")" : "";
    $("keptGuards").textContent = "Filter: " + p.needles + " personal word(s), plus shapes like phone numbers · local judge: " + (p.judge || "off");
    renderList("keptList", p.keptIn, (k) => { const li = el("li"); li.append(el("div", "", k.why), el("div", "small", k.when + " · would have gone to " + k.backend)); li.title = k.at; return li; }, "Nothing has been kept in.");
    document.querySelectorAll(".subj").forEach((e) => e.textContent = subject);
    renderList("basisList", p.basis, (b) => {
      const li = el("li"); const row = el("div", "row"); row.style.justifyContent = "space-between"; row.style.marginTop = "0";
      const who = el("div"); who.append(el("div", "", b.basis + " — " + b.uses.join(", ") + " "), el("div", "small", b.id + " · " + b.state + " · by " + b.approvedBy + " on " + b.at + " · " + (b.expires ? "until " + b.expires : "no end date") + (b.note ? " · " + b.note : "")));
      row.append(who);
      if (b.state === "active") {
        const rv = el("button", "danger", "Revoke");
        rv.onclick = async () => { if (!confirm("Revoke " + b.id + "?\\n\\nNothing more comes in on it. What already came in stays until erased.")) return; rv.disabled = true; const r = await api("/api/basis/revoke", { id: b.id }); toast(r.ok ? "Revoked." : (r.message || r.error || "That did not work.")); loadPrivacy(); };
        row.append(rv);
      }
      li.append(row); return li;
    }, "No basis on record — nothing of this subject can be taken in.");
  }
  let draftData = null;
  async function loadDrafts() {
    let r; try { r = await api("/api/persona"); } catch { return; }
    draftData = r.draft; drawDrafts();
  }
  function drawDrafts() {
    const box = $("draftList"); box.replaceChildren();
    if (!draftData) { box.append(el("p", "empty", "No draft yet. Draft one in a terminal: mind persona extract <dir> --subject " + subject + " --from <folder>")); $("draftCount").textContent = ""; $("draftAdopt").disabled = true; return; }
    const cl = draftData.claims, open = cl.filter((c) => c.decision === null).length, yes = cl.filter((c) => c.decision === "yes").length;
    $("draftCount").textContent = "(" + open + " open · " + yes + " yes · " + (cl.length - open - yes) + " no)";
    $("draftAdopt").disabled = yes === 0;
    const want = $("draftShow").value;
    const shown = cl.filter((c) => want === "all" || (want === "open" ? c.decision === null : c.decision === want));
    if (!shown.length) { box.append(el("p", "empty", "Nothing here.")); return; }
    for (const c of shown.slice(0, 60)) {
      const card = el("div", "card");
      const t = el("p", "what", c.text); t.append(el("span", "tag", c.field)); card.append(t);
      card.append(el("p", "meta", "“" + c.quote + "” — " + c.source.label + ":" + c.source.line));
      const row = el("div", "row");
      const y = el("button", c.decision === "yes" ? "primary" : "", "True of the job"), n = el("button", c.decision === "no" ? "danger" : "", "Not");
      const answer = async (a) => { y.disabled = n.disabled = true; const r = await api("/api/persona/decide", { claim: c.id, answer: a }); if (!r.ok) toast(r.message || "That did not work."); else { c.decision = a; drawDrafts(); } };
      y.onclick = () => answer("yes"); n.onclick = () => answer("no");
      row.append(y, n); card.append(row); box.append(card);
    }
  }
  $("draftShow").addEventListener("change", drawDrafts);
  $("draftAdopt").onclick = async () => {
    const dry = await api("/api/persona/adopt", { write: false });
    if (!dry.ok) { toast(dry.message || "Nothing to write."); return; }
    if (!confirm((dry.text || "Write the answered-yes claims into the soul?") + "\\n\\nWrite it now? Nothing is committed.")) return;
    const r = await api("/api/persona/adopt", { write: true });
    toast(r.ok ? "Written into the soul. git diff shows it." : (r.message || "Not written."));
    loadDrafts(); refresh(); loadProfile();
  };
  // ── Memories: create, edit, delete (D-081) ──
  const MEM_TEMPLATE = "---\\nname: \\ndescription: \\nmetadata:\\n  type: reference\\n---\\n\\n";
  let memEditing = null; // null = not editing; "" = new; path = editing that file
  function memMode(editing) {
    $("memImport").hidden = true; $("memEditor").hidden = !editing; $("memText").hidden = editing || !memShown; $("memTagBox").hidden = editing || !memShown; $("memActions").hidden = editing || !memShown;
  }
  function openEditor(path, text) {
    memEditing = path;
    $("memEdPath").value = path || "memory/notes/" + new Date().toISOString().slice(0, 10) + "-note.md";
    $("memEdPath").disabled = !!path;
    $("memEdText").value = text; $("memEdText").hidden = false; $("memEdPreview").hidden = true; $("memEdPrev").textContent = "Preview";
    $("memEdNote").textContent = ""; $("memPath").textContent = path ? "Editing " + path : "New memory";
    memMode(true); $("memEdText").focus();
  }
  $("memNew").onclick = () => { memShown = ""; drawMemories(); openEditor("", MEM_TEMPLATE); };
  $("memEdit").onclick = () => { if (memShown) openEditor(memShown, memLast); };
  $("memEdCancel").onclick = () => { memEditing = null; memMode(false); $("memPath").textContent = memShown || "Pick a memory on the left."; };
  $("memEdPrev").onclick = () => {
    const on = $("memEdPreview").hidden;
    $("memEdPreview").hidden = !on; $("memEdText").hidden = on; $("memEdPrev").textContent = on ? "Edit text" : "Preview";
    if (on) { $("memEdPreview").replaceChildren(md($("memEdText").value)); }
  };
  $("memEdSave").onclick = async () => {
    const path = $("memEdPath").value.trim(), text = $("memEdText").value;
    $("memEdSave").disabled = true; $("memEdNote").textContent = "Saving and re-indexing…";
    let r; try { r = await api("/api/memory/write", { path, content: text }); } catch { $("memEdSave").disabled = false; return; }
    $("memEdSave").disabled = false; $("memEdNote").textContent = "";
    if (!r.ok) { toast(r.message || r.error || "Not saved."); return; }
    toast(r.message || "Saved."); memEditing = null; await loadMemories(); openMemory(path);
  };
  $("memMove").onclick = async () => {
    const path = memShown; if (!path) return;
    const to = kindOf(path) === "knowledge" ? "memory" : "knowledge";
    const plan = await api("/api/memory/move", { path, to });
    if (!plan.ok) { toast(plan.message || plan.error || "Cannot move it."); return; }
    if (!confirm("Move to " + to + "?\\n\\n" + (plan.message || "") + "\\n\\nBoth indexes are rebuilt. Git keeps the old path until you commit the move.")) return;
    $("memMove").disabled = true;
    const r = await api("/api/memory/move", { path, to, write: true });
    $("memMove").disabled = false;
    toast(r.ok ? "Moved to " + to + "." : (r.message || "Not moved.")); if (r.ok) { await loadMemories(); openMemory(movedTo(path, to)); }
  };
  $("memDelete").onclick = async () => {
    const path = memShown; if (!path) return;
    const plan = await api("/api/memory/delete", { path });
    if (!plan.ok) { toast(plan.message || "Cannot delete it."); return; }
    if (!confirm("Delete " + path + "?\\n\\n" + (plan.message || "") + "\\n\\nThe file goes, both indexes are rebuilt. Git history still holds it.")) return;
    const r = await api("/api/memory/delete", { path, write: true });
    toast(r.ok ? "Deleted." : (r.message || "Not deleted.")); memShown = ""; memMode(false); $("memPath").textContent = "Pick a memory on the left."; loadMemories();
  };
  let mems = []; let memShown = ""; let memKind = ""; let memTag = "";
  // D-091: collections — every tag with how many memories are in it; one pressed narrows the list and the map.
  function drawTags() {
    const row = $("memTags"); row.replaceChildren();
    const count = new Map(); for (const m of mems) for (const t of m.tags || []) count.set(t, (count.get(t) || 0) + 1);
    if (memTag && !count.has(memTag)) memTag = "";
    for (const [t, n] of [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const b = el("button", "tagchip", "#" + t); b.append(el("b", "", String(n))); b.setAttribute("aria-pressed", String(t === memTag));
      b.onclick = () => { memTag = memTag === t ? "" : t; drawTags(); drawMemories(); };
      row.append(b);
    }
    row.hidden = count.size === 0;
  }
  function showTagsOf(path) {
    const m = mems.find((x) => x.path === path); const list = $("memTagList"); list.replaceChildren();
    $("memTagBox").hidden = !m;
    if (!m) return;
    if (!m.tags.length) list.append(el("span", "small", "none"));
    for (const t of m.tags) { const b = el("button", "tagchip", "#" + t); b.onclick = () => { memTag = t; drawTags(); drawMemories(); }; list.append(b); }
  }
  $("memTagEdit").onclick = async () => {
    const m = mems.find((x) => x.path === memShown); if (!m) return;
    const typed = prompt("Collections for " + m.title + " — separate them with commas:", m.tags.join(", "));
    if (typed === null) return;
    const tags = typed.split(",").map((t) => t.trim()).filter(Boolean);
    const r = await api("/api/memory/tags", { path: m.path, tags });
    toast(r.ok ? "Collections saved." : (r.message || r.error || "Not saved.")); if (r.ok) { await loadMemories(); openMemory(m.path); }
  };
  // D-090: the person's memory, knowledge (memory/knowledge/), or both.
  function kindOf(path) { return path.startsWith("memory/knowledge/") ? "knowledge" : "memory"; }
  function movedTo(path, to) { const name = path.split("/").pop(); return to === "knowledge" ? "memory/knowledge/" + name : "memory/notes/" + name; }
  document.querySelectorAll("#memKind button").forEach((b) => b.onclick = () => {
    memKind = b.dataset.kind; document.querySelectorAll("#memKind button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawMemories();
  });
  function drawMemories() {
    const q = $("memFilter").value.trim().toLowerCase(); const kind = $("memType").value;
    const list = $("memList"); list.replaceChildren();
    const hits = mems.filter((m) => (!memKind || m.kind === memKind) && (!memTag || (m.tags || []).includes(memTag)) && (!kind || m.type === kind) && (!q || (m.title + " " + m.description + " " + m.path).toLowerCase().includes(q)));
    const counts = { "": mems.length, memory: mems.filter((m) => m.kind === "memory").length, knowledge: mems.filter((m) => m.kind === "knowledge").length };
    document.querySelectorAll("#memKind button").forEach((b) => { b.textContent = (b.dataset.kind ? b.dataset.kind[0].toUpperCase() + b.dataset.kind.slice(1) : "All") + " " + counts[b.dataset.kind]; });
    $("memCount").textContent = "(" + (hits.length === mems.length ? mems.length : hits.length + " of " + mems.length) + ")";
    if (!hits.length) { list.append(el("p", "empty", mems.length ? "Nothing matches." : "No memories yet. Notes go in memory/ in its repository.")); return; }
    for (const m of hits) {
      const b = el("button", "mem"); b.setAttribute("aria-current", String(m.path === memShown));
      const t = el("div", "what", m.title); if (m.kind === "knowledge") t.append(el("span", "tag kn", "knowledge")); if (m.type) t.append(el("span", "tag", m.type)); for (const tg of (m.tags || []).slice(0, 3)) t.append(el("span", "tag", "#" + tg));
      b.append(t, el("div", "small clamp2", m.description), el("div", "small", m.path + " · " + Math.max(1, Math.round(m.bytes / 1024)) + " KB"));
      b.onclick = () => openMemory(m.path);
      list.append(b);
    }
  }
  async function openMemory(path) {
    memShown = path; drawMemories(); $("memPath").textContent = path; $("memText").hidden = false; $("memText").textContent = "Loading…";
    if (window.matchMedia("(max-width: 860px)").matches) $("h-memview").scrollIntoView({ behavior: "smooth", block: "start" });
    let r; try { r = await api("/api/memory?path=" + encodeURIComponent(path)); } catch { return; }
    memLast = r.error ? "" : r.text; showMem(r.error || "");
    memEditing = null; $("memEditor").hidden = true; $("memImport").hidden = true; $("memActions").hidden = !!r.error;
    $("memMove").textContent = kindOf(path) === "knowledge" ? "Move to Memory…" : "Move to Knowledge…";
    showTagsOf(r.error ? "" : path);
  }
  let memLast = "";
  function showMem(error) {
    const box = $("memText"); box.replaceChildren();
    if (error) { box.textContent = error; return; }
    if ($("memRaw").checked) { box.style.whiteSpace = "pre-wrap"; box.textContent = memLast; }
    else { box.style.whiteSpace = "normal"; box.append(md(memLast)); }
  }
  $("memRaw").addEventListener("change", () => { if (memLast) showMem(""); });
  async function loadMemories() {
    try { mems = await api("/api/memories"); } catch { return; }
    const sel = $("memType"); const keep = sel.value; sel.replaceChildren(el("option", "", "All kinds")); sel.firstChild.value = "";
    for (const k of [...new Set(mems.map((m) => m.type).filter(Boolean))].sort()) { const o = el("option", "", k); o.value = k; sel.append(o); }
    sel.value = keep; drawTags(); drawMemories(); loadMap(); loadFacts();
  }
  // D-082: the memory map — a force layout in 3D, drawn on a canvas by hand (no library: the page ships in the binary).
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TYPE_VAR = { user: "--primary", feedback: "--warning", project: "--brand-2" };
  const map = { nodes: [], edges: [], deg: [], adj: [], index: new Map(), x: [], y: [], z: [], vx: [], vy: [], vz: [], heat: 0, rx: -0.35, ry: 0, zoom: 1, spin: !still, hover: -1, mouse: null, drag: null, pulses: [], raf: 0, last: 0, proj: [] };
  function mapColor(type, css) { return css(TYPE_VAR[type] || "--muted-foreground"); }
  // D-092: the things memories share, drawn as diamonds when "Things" is on.
  const ENTITY_VAR = { port: "--destructive", service: "--success", host: "--warning", env: "--brand-2", path: "--muted-foreground" };
  let mapThings = store.get("mind-map-things") === "on", mapFull = null;
  function withThings(g) {
    if (!mapThings || !g.entities || !g.entities.length) return g;
    const base = g.nodes.length;
    return {
      nodes: g.nodes.concat(g.entities.map((e) => ({ path: "entity:" + e.type + ":" + e.value, title: e.value, type: "", kind: "entity", etype: e.type, count: e.count, tags: [] }))),
      edges: g.edges.concat(g.mentions.map(([ei, ni]) => [ni, base + ei, 1])),
      dangling: g.dangling, entities: g.entities, mentions: g.mentions,
    };
  }
  // What part of memory the map shows. Hundreds of memories drawn at once are a hairball and a hot laptop, so
  // the map lays out and draws only its view: the most linked (or all), what a find matches and what that links
  // to, or the chosen memory and the ones a step or two away — with kinds the legend has turned off left out.
  const MAP_LIMITS = [60, 150, 300, 0];
  const mapView = {
    find: "",
    limit: MAP_LIMITS.includes(Number(store.get("mind-map-limit") || 150)) ? Number(store.get("mind-map-limit") || 150) : 150,
    around: 0,
    loose: store.get("mind-map-loose") !== "off",
    off: new Set(store.get("mind-map-off").split(",").filter(Boolean)),
    centre: "", hits: null,
  };
  const legendKey = (m) => m.kind === "entity" ? "thing:" + m.etype : "type:" + (m.type || "");
  async function loadMap() {
    let g; try { g = await api("/api/memories/graph"); } catch { return; }
    g = withThings(g);
    g.deg = g.nodes.map(() => 0); g.adj = g.nodes.map(() => []); g.index = new Map(g.nodes.map((m, i) => [m.path, i]));
    g.links = g.nodes.map(() => 0);
    for (const [a, b] of g.edges) { g.deg[a]++; g.deg[b]++; g.adj[a].push(b); g.adj[b].push(a); if (g.nodes[a].kind !== "entity" && g.nodes[b].kind !== "entity") { g.links[a]++; g.links[b]++; } }
    mapFull = g;
    mapLegend(); mapApply();
  }
  function mapLegend() {
    const g = mapFull; if (!g) return;
    const css = (v) => "hsl(" + getComputedStyle(document.documentElement).getPropertyValue(v).trim() + ")";
    const leg = $("mapLegend"); leg.replaceChildren();
    const count = new Map(); for (const m of g.nodes) count.set(legendKey(m), (count.get(legendKey(m)) || 0) + 1);
    for (const k of [...count.keys()].sort()) {
      const thing = k.startsWith("thing:"), name = k.slice(k.indexOf(":") + 1);
      const b = el("button", "legchip"), dot = el("i");
      dot.style.background = thing ? css(ENTITY_VAR[name]) : mapColor(name, css); if (thing) dot.style.borderRadius = "2px";
      b.append(dot, (thing ? "◆ " : "") + (name || "no kind")); b.append(el("b", "", String(count.get(k))));
      b.setAttribute("aria-pressed", String(!mapView.off.has(k))); b.title = "Show or hide " + (name || "memories with no kind") + " on the map";
      b.onclick = () => { if (mapView.off.has(k)) mapView.off.delete(k); else mapView.off.add(k); store.set("mind-map-off", [...mapView.off].join(",")); mapLegend(); mapApply(); };
      leg.append(b);
    }
    leg.append(el("span", "", "● memory · ■ knowledge (" + g.nodes.filter((m) => m.kind === "knowledge").length + ")"));
  }
  // Pick the view out of the whole graph, keep every dot that stays where it was, and lay out only that.
  function mapApply() {
    const g = mapFull; if (!g) return;
    const N = g.nodes.length, deg = g.deg, adj = g.adj;
    const ent = (i) => g.nodes[i].kind === "entity", kindOn = (i) => !mapView.off.has(legendKey(g.nodes[i]));
    const byDeg = (a, b) => deg[b] - deg[a] || (g.nodes[a].path < g.nodes[b].path ? -1 : 1);
    const q = mapView.find.trim().toLowerCase();
    const desc = new Map(mems.map((m) => [m.path, m.description || ""]));
    const hit = (i) => { const m = g.nodes[i]; return (m.title + " " + m.path + " " + (desc.get(m.path) || "") + " " + (m.tags || []).join(" ")).toLowerCase().includes(q); };
    const centre = mapView.around && g.index.has(memShown) && !ent(g.index.get(memShown)) ? g.index.get(memShown) : -1;
    mapView.centre = memShown;
    const all = [...Array(N).keys()];
    let pick, hits = null;
    if (centre >= 0) {
      // Out from the chosen memory along its links, a step at a time; Things are not a way across.
      const dist = new Map([[centre, 0]]), queue = [centre];
      for (let h = 0; h < queue.length; h++) {
        const i = queue[h]; if (dist.get(i) >= mapView.around) continue;
        for (const j of adj[i]) if (!dist.has(j) && !ent(j) && kindOn(j)) { dist.set(j, dist.get(i) + 1); queue.push(j); }
      }
      pick = [...dist.keys()].sort((a, b) => dist.get(a) - dist.get(b) || byDeg(a, b));
      if (q) hits = new Set(pick.filter(hit));
    } else if (q) {
      // What matches first, then what it links to — so a find shows where a thing sits, not a lone dot.
      const found = all.filter((i) => kindOn(i) && hit(i)).sort(byDeg), seen = new Set(found);
      const next = [...new Set(found.flatMap((i) => adj[i]))].filter((j) => !seen.has(j) && !ent(j) && kindOn(j)).sort(byDeg);
      pick = found.concat(next); hits = seen;
    } else pick = all.filter((i) => !ent(i) && kindOn(i) && (mapView.loose || g.links[i] > 0)).sort(byDeg);
    const shown = mapView.limit ? pick.slice(0, mapView.limit) : pick;
    // Things shared by two or more of the memories in view come along, the most shared first.
    if (mapThings) {
      const inView = new Set(shown);
      const things = all.filter((i) => ent(i) && !inView.has(i) && kindOn(i)).map((i) => [i, adj[i].filter((j) => inView.has(j)).length]).filter(([, c]) => c >= 2);
      things.sort((a, b) => b[1] - a[1]);
      for (const [i] of things.slice(0, Math.max(20, Math.round(shown.length / 3)))) shown.push(i);
    }
    const keep = new Map(shown.map((i, k) => [i, k])), n = shown.length;
    const old = new Map(map.nodes.map((m, i) => [m.path, [map.x[i], map.y[i], map.z[i]]]));
    map.nodes = shown.map((i) => g.nodes[i]); map.pulses = []; map.hover = -1;
    map.edges = []; for (const [a, b, w] of g.edges) if (keep.has(a) && keep.has(b)) map.edges.push([keep.get(a), keep.get(b), w]);
    map.deg = map.nodes.map(() => 0); map.adj = map.nodes.map(() => []); map.index = new Map(map.nodes.map((m, i) => [m.path, i]));
    for (const [a, b] of map.edges) { map.deg[a]++; map.deg[b]++; map.adj[a].push(b); map.adj[b].push(a); }
    map.size = shown.map((i) => deg[i]);
    map.hubs = [...Array(n).keys()].filter((i) => map.size[i] > 0).sort((a, b) => map.size[b] - map.size[a]).slice(0, 7);
    mapView.hits = hits ? new Set([...hits].filter((i) => keep.has(i)).map((i) => keep.get(i))) : null;
    const R = 40 * Math.cbrt(n || 1);
    for (const k of ["x", "y", "z", "vx", "vy", "vz"]) map[k] = new Array(n).fill(0);
    let fresh = 0;
    for (let i = 0; i < n; i++) {
      const was = old.get(map.nodes[i].path);
      if (was) { map.x[i] = was[0]; map.y[i] = was[1]; map.z[i] = was[2]; continue; }
      fresh++;
      // A dot new to the view starts beside a neighbour already placed, so the map grows instead of jumping.
      const by = map.adj[i].find((j) => old.has(map.nodes[j].path));
      if (by !== undefined) { const o = old.get(map.nodes[by].path); map.x[i] = o[0] + (Math.random() - 0.5) * 30; map.y[i] = o[1] + (Math.random() - 0.5) * 30; map.z[i] = o[2] + (Math.random() - 0.5) * 30; continue; }
      const t = Math.acos(1 - 2 * (i + 0.5) / n), p = Math.PI * (1 + Math.sqrt(5)) * i;
      map.x[i] = R * Math.sin(t) * Math.cos(p); map.y[i] = R * Math.cos(t); map.z[i] = R * Math.sin(t) * Math.sin(p);
    }
    map.heat = fresh > n * 0.3 ? 1 : Math.max(map.heat, 0.35);
    if (still) { for (let i = 0; i < 250 && map.heat > 0.005; i++) mapStep(); }
    // The counts are of the whole memory; "showing" says how much of it is on screen.
    const things = g.nodes.filter((m) => m.kind === "entity").length, notes = N - things;
    const loose = g.nodes.filter((m, i) => m.kind !== "entity" && g.links[i] === 0).length;
    const seenNotes = map.nodes.filter((m) => m.kind !== "entity").length, seenThings = n - seenNotes;
    $("mapStats").textContent = "(" + (seenNotes < notes ? "showing " + seenNotes + " of " : "") + notes + " neurons · " + (g.edges.length - (things ? g.mentions.length : 0)) + " synapses" + (things ? " · " + (seenThings < things ? seenThings + " of " : "") + things + " shared things" : "") + (loose ? " · " + loose + " unlinked" : "") + (g.dangling ? " · " + g.dangling + " broken link" + (g.dangling === 1 ? "" : "s") : "") + ")";
    const note = mapView.around && centre < 0 ? "Pick a memory — in the list or on the map — to see around it." : q && !pick.length ? "Nothing in memory matches “" + mapView.find.trim() + "”." : "";
    $("mapCanvas").setAttribute("aria-label", "Memory map: " + seenNotes + " of " + notes + " memories as dots, the links between them as lines. " + (note || "The list below holds the same memories."));
    $("mapEmpty").textContent = note; $("mapEmpty").hidden = !note;
    $("mapClear").hidden = !(q || mapView.around || mapView.off.size || !mapView.loose || mapView.limit !== 150);
    mapStart();
  }
  const mapFindNow = () => { mapView.find = $("mapFind").value; mapApply(); };
  let mapFindTimer = 0;
  $("mapFind").addEventListener("input", () => { clearTimeout(mapFindTimer); mapFindTimer = setTimeout(mapFindNow, 180); });
  $("mapFind").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("mapFind").value) { e.preventDefault(); $("mapFind").value = ""; mapFindNow(); } });
  $("mapLimit").value = String(mapView.limit);
  $("mapLimit").onchange = () => { mapView.limit = Number($("mapLimit").value); store.set("mind-map-limit", String(mapView.limit)); mapApply(); };
  $("mapAround").onchange = () => { mapView.around = Number($("mapAround").value); mapApply(); };
  $("mapLoose").checked = mapView.loose;
  $("mapLoose").onchange = () => { mapView.loose = $("mapLoose").checked; store.set("mind-map-loose", mapView.loose ? "" : "off"); mapApply(); };
  $("mapClear").onclick = () => {
    $("mapFind").value = ""; mapView.find = ""; mapView.around = 0; $("mapAround").value = "0"; mapView.off.clear(); store.set("mind-map-off", "");
    mapView.loose = true; $("mapLoose").checked = true; store.set("mind-map-loose", ""); mapView.limit = 150; $("mapLimit").value = "150"; store.set("mind-map-limit", "");
    mapLegend(); mapApply();
  };
  function mapStep() {
    const n = map.nodes.length; if (!n || map.heat < 0.005) return;
    const fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = map.x[i] - map.x[j], dy = map.y[i] - map.y[j], dz = map.z[i] - map.z[j];
      const d2 = dx * dx + dy * dy + dz * dz + 0.01, d = Math.sqrt(d2), f = 900 / d2;
      fx[i] += dx / d * f; fy[i] += dy / d * f; fz[i] += dz / d * f; fx[j] -= dx / d * f; fy[j] -= dy / d * f; fz[j] -= dz / d * f;
    }
    for (const [a, b, w] of map.edges) {
      const dx = map.x[b] - map.x[a], dy = map.y[b] - map.y[a], dz = map.z[b] - map.z[a];
      // A hub (an index that links everything) pulls weakly on each, or it knots the whole map around itself.
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01, f = (d - 34) * 0.08 * Math.sqrt(Math.min(w, 4)) / Math.sqrt(Math.max(1, Math.min(map.deg[a], map.deg[b])));
      fx[a] += dx / d * f; fy[a] += dy / d * f; fz[a] += dz / d * f; fx[b] -= dx / d * f; fy[b] -= dy / d * f; fz[b] -= dz / d * f;
    }
    for (let i = 0; i < n; i++) {
      const pull = map.deg[i] ? 0.012 : 0.05;
      map.vx[i] = (map.vx[i] + fx[i] - map.x[i] * pull) * 0.6; map.vy[i] = (map.vy[i] + fy[i] - map.y[i] * pull) * 0.6; map.vz[i] = (map.vz[i] + fz[i] - map.z[i] * pull) * 0.6;
      map.x[i] += map.vx[i] * map.heat; map.y[i] += map.vy[i] * map.heat; map.z[i] += map.vz[i] * map.heat;
    }
    map.heat *= 0.985;
  }
  // A soft glow, drawn once per colour and then stamped: a canvas blur on every dot every frame is what made a big map crawl.
  const glows = new Map();
  function glowOf(color) {
    let g = glows.get(color); if (g) return g;
    g = document.createElement("canvas"); g.width = g.height = 64; const c = g.getContext("2d");
    c.fillStyle = color; c.fillRect(0, 0, 64, 64);
    const fade = c.createRadialGradient(32, 32, 0, 32, 32, 32); fade.addColorStop(0, "rgba(0,0,0,1)"); fade.addColorStop(0.35, "rgba(0,0,0,.45)"); fade.addColorStop(1, "rgba(0,0,0,0)");
    c.globalCompositeOperation = "destination-in"; c.fillStyle = fade; c.fillRect(0, 0, 64, 64);
    glows.set(color, g); return g;
  }
  function mapDraw(dt) {
    const c = $("mapCanvas"), w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const n = map.nodes.length; if (!n) return;
    const style = getComputedStyle(document.documentElement), css = (v) => "hsl(" + style.getPropertyValue(v).trim() + ")";
    const ink = css("--foreground"), brand = css("--primary");
    // Fit the bulk, not the farthest stray: the 95th-percentile distance fills the frame, and nothing is drawn
    // nearer than the front of that — a stray close to the eye would blow up and throw its lines off the edge.
    const radii = map.x.map((x, i) => Math.hypot(x, map.y[i], map.z[i])).sort((a, b) => a - b);
    const rmax = Math.max(1, radii[Math.floor((n - 1) * 0.95)]);
    const scale = Math.min(w, h) * 0.46 / rmax * map.zoom;
    const cy = Math.cos(map.ry), sy = Math.sin(map.ry), cx = Math.cos(map.rx), sx = Math.sin(map.rx);
    const P = map.proj = new Array(n);
    for (let i = 0; i < n; i++) {
      const x1 = map.x[i] * cy - map.z[i] * sy, z1 = map.x[i] * sy + map.z[i] * cy;
      const y1 = map.y[i] * cx - z1 * sx, z2 = map.y[i] * sx + z1 * cx;
      const k = 1 / (1 + Math.max(-rmax * 1.2, z2) / (rmax * 3.2));
      P[i] = { x: w / 2 + x1 * scale * k, y: h / 2 + y1 * scale * k, z: z2, k, r: (2.6 + Math.sqrt(map.size[i] || 0) * 1.7) * k * Math.sqrt(map.zoom) };
    }
    // What the pointer is on: the nearest dot within reach, front ones first.
    map.hover = -1;
    if (map.mouse && !(map.drag && map.drag.moved > 5)) {
      let best = 1e9;
      for (let i = 0; i < n; i++) { const d = Math.hypot(P[i].x - map.mouse[0], P[i].y - map.mouse[1]) - P[i].r; if (d < 8 && d + P[i].z * 0.001 < best) { best = d + P[i].z * 0.001; map.hover = i; } }
    }
    const q = $("memFilter").value.trim().toLowerCase(), kind = $("memType").value;
    const match = (m) => m.kind === "entity" ? (!q || m.title.toLowerCase().includes(q)) : (!memKind || m.kind === memKind) && (!memTag || (m.tags || []).includes(memTag)) && (!kind || m.type === kind) && (!q || (m.title + " " + m.path).toLowerCase().includes(q));
    const sel = map.index.has(memShown) ? map.index.get(memShown) : -1;
    const focus = map.hover >= 0 ? map.hover : sel;
    const near = new Set(focus >= 0 ? [focus, ...map.adj[focus]] : []);
    // Lit once a frame, not once a line: the list's filter, the map's find, and the focus all have to agree.
    const on = new Uint8Array(n);
    for (let i = 0; i < n; i++) on[i] = match(map.nodes[i]) && (!mapView.hits || mapView.hits.has(i) || near.has(i)) && (focus < 0 || near.has(i)) ? 1 : 0;
    const lit = (i) => on[i] === 1;
    // Synapses, batched: every line that looks the same goes in one path and one stroke.
    ctx.lineCap = "round";
    const batches = new Map(), hot = [];
    for (let e = 0; e < map.edges.length; e++) {
      const [a, b, wt] = map.edges[e];
      if (focus >= 0 && (a === focus || b === focus)) { hot.push(e); continue; }
      // After a find, what a found memory links to stays traceable even where the far end is dimmed.
      const alpha = lit(a) && lit(b) ? 0.1 + 0.2 * Math.min(1, P[a].k, P[b].k) : mapView.hits && (mapView.hits.has(a) || mapView.hits.has(b)) && (lit(a) || lit(b)) ? 0.16 : 0.04;
      const key = Math.round(alpha * 40) + "|" + Math.min(4, Math.round(wt)) + "|" + (map.nodes[b].kind === "entity" ? 1 : 0);
      const list = batches.get(key); if (list) list.push(e); else batches.set(key, [e]);
    }
    ctx.strokeStyle = ink;
    for (const [key, list] of batches) {
      const [al, wq, dash] = key.split("|").map(Number);
      ctx.globalAlpha = al / 40; ctx.lineWidth = 0.7 + wq * 0.25; ctx.setLineDash(dash ? [3, 4] : []);
      ctx.beginPath(); for (const e of list) { const [a, b] = map.edges[e]; ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); } ctx.stroke();
    }
    ctx.strokeStyle = brand; ctx.globalAlpha = 0.85;
    for (const e of hot) {
      const [a, b, wt] = map.edges[e];
      ctx.lineWidth = 1.4 + Math.min(wt, 4) * 0.25; ctx.setLineDash(map.nodes[b].kind === "entity" ? [3, 4] : []);
      ctx.beginPath(); ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // Signals running along the synapses.
    if (!still && map.edges.length) {
      const rate = Math.min(6, 1 + map.edges.length / 16) * dt / 1000;
      if (Math.random() < rate) { const e = Math.floor(Math.random() * map.edges.length); map.pulses.push({ e, t: 0, back: Math.random() < 0.5 }); }
      if (focus >= 0 && Math.random() < dt / 180) { const js = map.adj[focus]; if (js.length) { const j = js[Math.floor(Math.random() * js.length)]; const e = map.edges.findIndex(([a, b]) => (a === focus && b === j) || (b === focus && a === j)); if (e >= 0) map.pulses.push({ e, t: 0, back: map.edges[e][0] !== focus }); } }
      map.pulses = map.pulses.filter((p) => (p.t += dt / 1100) < 1).slice(-60);
      ctx.fillStyle = brand;
      const pr = 1.8 * Math.sqrt(map.zoom);
      for (const p of map.pulses) {
        const [a, b] = map.edges[p.e]; const from = P[p.back ? b : a], to = P[p.back ? a : b];
        const x = from.x + (to.x - from.x) * p.t, y = from.y + (to.y - from.y) * p.t, a0 = Math.sin(p.t * Math.PI) * (lit(a) || lit(b) ? 0.95 : 0.2);
        ctx.globalAlpha = a0 * 0.8; ctx.drawImage(glowOf(brand), x - pr * 4, y - pr * 4, pr * 8, pr * 8);
        ctx.globalAlpha = a0; ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Neurons, far ones first. Only what is in focus gets a real blur; the rest the stamped glow.
    const order = [...P.keys()].sort((a, b) => P[b].z - P[a].z);
    for (const i of order) {
      const p = P[i], ent = map.nodes[i].kind === "entity", color = ent ? css(ENTITY_VAR[map.nodes[i].etype]) : mapColor(map.nodes[i].type, css), bright = lit(i);
      ctx.fillStyle = color;
      if (bright) { const g = p.r * 3; ctx.globalAlpha = 0.45 * Math.min(1, p.k); ctx.drawImage(glowOf(color), p.x - g, p.y - g, g * 2, g * 2); }
      ctx.globalAlpha = bright ? 0.35 + 0.65 * Math.min(1, p.k) : 0.12;
      const glow = bright && focus >= 0 && near.has(i);
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14 * p.k; }
      ctx.beginPath();
      // Knowledge is a square, the person's memory a round cell (D-090).
      if (ent) { ctx.moveTo(p.x, p.y - p.r * 1.2); ctx.lineTo(p.x + p.r, p.y); ctx.lineTo(p.x, p.y + p.r * 1.2); ctx.lineTo(p.x - p.r, p.y); ctx.closePath(); }
      else if (map.nodes[i].kind === "knowledge") ctx.rect(p.x - p.r * 0.9, p.y - p.r * 0.9, p.r * 1.8, p.r * 1.8); else ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      if (glow) ctx.shadowBlur = 0;
      if (i === sel || i === map.hover || (mapView.hits && mapView.hits.has(i) && focus < 0)) { ctx.globalAlpha = i === sel || i === map.hover ? 1 : 0.7; ctx.strokeStyle = brand; ctx.lineWidth = i === sel || i === map.hover ? 2 : 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.shadowBlur = 0;
    // Names: the hubs (or, after a find, what it found), and whatever is in focus.
    const hubs = (mapView.hits ? [...mapView.hits].sort((a, b) => (map.size[b] || 0) - (map.size[a] || 0)) : map.hubs).slice(0, w > 700 ? 7 : 4);
    ctx.font = "600 11px Inter, 'IBM Plex Sans Thai', system-ui, sans-serif"; ctx.textAlign = "center";
    const taken = [];
    for (const i of [...new Set(focus >= 0 ? [focus, ...near] : hubs)]) {
      if (!lit(i) && i !== focus) continue;
      const t0 = map.nodes[i].title, t = t0.length > 28 ? t0.slice(0, 27) + "…" : t0;
      const tw = ctx.measureText(t).width, bx = P[i].x - tw / 2, by = P[i].y - P[i].r - 17;
      // A name that would sit on another is left off; the focused one always shows.
      if (i !== focus && taken.some((b) => bx < b[0] + b[2] && b[0] < bx + tw && by < b[1] + 13 && b[1] < by + 13)) continue;
      taken.push([bx, by, tw]);
      ctx.globalAlpha = 0.85; ctx.fillStyle = css("--card"); ctx.fillRect(bx - 3, by, tw + 6, 14);
      ctx.globalAlpha = i === focus ? 1 : 0.8; ctx.fillStyle = ink; ctx.fillText(t, P[i].x, by + 11);
    }
    ctx.globalAlpha = 1;
    const tip = $("mapTip");
    if (map.hover < 0) tip.hidden = true;
    else {
      const m = map.nodes[map.hover];
      tip.replaceChildren(el("div", "what", m.title), el("div", "small", m.kind === "entity" ? m.etype + " · in " + m.count + " memories · click to see where" : (m.type || "no kind") + " · " + (map.size[map.hover] || 0) + " link(s)" + (map.size[map.hover] > map.deg[map.hover] ? ", " + map.deg[map.hover] + " on screen" : "") + " · " + m.path));
      tip.hidden = false; tip.style.left = Math.min(w - 240, P[map.hover].x + 14) + "px"; tip.style.top = Math.max(4, P[map.hover].y - 12) + "px";
    }
    c.style.cursor = map.drag ? "grabbing" : map.hover >= 0 ? "pointer" : "grab";
  }
  function mapFrame(now) {
    map.raf = 0;
    if ($("memories").hidden || $("mapBody").hidden || document.hidden) return;
    const dt = map.last ? Math.min(64, now - map.last) : 16; map.last = now;
    if (mapView.around && mapView.centre !== memShown) mapApply();
    mapStep(); if (map.spin && !map.drag) map.ry += dt * 0.00012;
    // At rest — laid out, nothing held or pointed at — every other frame is drawn: the slow turn looks the same for half the work.
    const rest = !map.drag && !map.mouse && map.heat < 0.005;
    if (!rest || !map.drawn || now - map.drawn > 28) { mapDraw(map.drawn ? Math.min(64, now - map.drawn) : 16); map.drawn = now; }
    map.raf = requestAnimationFrame(mapFrame);
  }
  function mapStart() { if (!map.raf) { map.last = 0; map.drawn = 0; map.raf = requestAnimationFrame(mapFrame); } }
  document.addEventListener("visibilitychange", mapStart);
  const cv = $("mapCanvas");
  const mouseAt = (e) => { const r = cv.getBoundingClientRect(); map.mouse = [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener("pointerdown", (e) => { mouseAt(e); map.drag = { x: e.clientX, y: e.clientY, moved: 0 }; try { cv.setPointerCapture(e.pointerId); } catch {} });
  cv.addEventListener("pointermove", (e) => {
    mouseAt(e);
    if (!map.drag) return;
    const dx = e.clientX - map.drag.x, dy = e.clientY - map.drag.y;
    map.drag.moved += Math.abs(dx) + Math.abs(dy); map.drag.x = e.clientX; map.drag.y = e.clientY;
    map.ry += dx * 0.008; map.rx = Math.max(-1.5, Math.min(1.5, map.rx + dy * 0.008));
  });
  cv.addEventListener("pointerup", (e) => {
    mouseAt(e); const click = map.drag && map.drag.moved < 6; map.drag = null;
    if (click && map.hover >= 0 && map.nodes[map.hover].kind === "entity") { showWho(map.nodes[map.hover].title); $("h-memview").scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" }); }
    else if (click && map.hover >= 0) { openMemory(map.nodes[map.hover].path); $("h-memview").scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" }); }
  });
  cv.addEventListener("pointercancel", () => { map.drag = null; });
  cv.addEventListener("pointerleave", () => { if (!map.drag) map.mouse = null; });
  cv.addEventListener("wheel", (e) => { e.preventDefault(); map.zoom = Math.max(0.4, Math.min(5, map.zoom * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
  $("mapEntities").setAttribute("aria-pressed", String(mapThings));
  $("mapEntities").onclick = () => { mapThings = !mapThings; store.set("mind-map-things", mapThings ? "on" : ""); $("mapEntities").setAttribute("aria-pressed", String(mapThings)); loadMap(); };
  // Who mentions a thing: in the Read panel, each memory a button that opens it at that line's note.
  async function showWho(thing) {
    let hits; try { hits = await api("/api/memory/who?q=" + encodeURIComponent(thing)); } catch { return; }
    memShown = ""; drawMemories(); memMode(false); $("memActions").hidden = true; $("memTagBox").hidden = true;
    $("memPath").textContent = "What mentions " + thing;
    const box = $("memText"); box.hidden = false; box.style.whiteSpace = "normal"; box.replaceChildren();
    if (!hits.length) { box.textContent = "Nothing in memory mentions " + thing + "."; return; }
    for (const h of hits) {
      box.append(el("div", "what", h.type + " " + h.value + " — " + h.mentions.length + " memor" + (h.mentions.length === 1 ? "y" : "ies")));
      for (const m of h.mentions) { const b = el("button", "mem"); b.append(el("div", "", m.title), el("div", "small mono", m.path + ":" + m.line + "  " + m.excerpt)); b.onclick = () => openMemory(m.path); box.append(b); }
    }
  }
  $("mapSpin").onclick = () => { map.spin = !map.spin; $("mapSpin").setAttribute("aria-pressed", String(map.spin)); };
  $("mapReset").onclick = () => { map.rx = -0.35; map.ry = 0; map.zoom = 1; map.heat = 1; };
  function mapShow(on) { $("mapBody").hidden = !on; $("mapToggle").textContent = on ? "Hide map" : "Show map"; $("mapToggle").setAttribute("aria-expanded", String(on)); $("mapSpin").hidden = $("mapReset").hidden = !on; store.set("mind-map", on ? "" : "off"); if (on) mapStart(); }
  $("mapToggle").onclick = () => mapShow($("mapBody").hidden);
  mapShow(store.get("mind-map") !== "off");
  // D-084: import files and links. Each is checked (a dry run) as it is added; Import writes the ones that passed.
  let queue = [];
  function drawQueue() {
    const ul = $("memQueue"); ul.replaceChildren();
    for (const q of queue) {
      const li = el("li"); const top = el("div", "row"); top.style.margin = "0"; top.style.justifyContent = "space-between";
      const state = { checking: ["Reading…", "pill ask"], ready: ["Ready", "pill act"], failed: ["Cannot import", "pill stop"], importing: ["Importing…", "pill ask"], done: ["Imported", "pill act"] }[q.state];
      top.append(el("span", "what", q.label), el("span", state[1], state[0]));
      li.append(top); if (q.message) li.append(el("div", "msg", q.message));
      if (q.state === "ready" || q.state === "failed") { const rm = el("button", "", "Remove"); rm.style.marginTop = "6px"; rm.onclick = () => { queue = queue.filter((x) => x !== q); drawQueue(); }; li.append(rm); }
      ul.append(li);
    }
    $("memImpGo").disabled = !queue.some((q) => q.state === "ready");
  }
  async function check(q) {
    q.state = "checking"; drawQueue();
    let r; try { r = await api("/api/memory/import", q.body); } catch { r = { ok: false, error: "The server did not answer." }; }
    q.state = r.ok ? "ready" : "failed"; q.message = r.message || r.error || ""; drawQueue();
  }
  function readB64(file) {
    return new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1] || ""); fr.onerror = () => no(fr.error); fr.readAsDataURL(file); });
  }
  async function addFiles(files) {
    for (const f of files) {
      const q = { label: f.name, state: "checking", message: "" }; queue.push(q);
      if (f.size > 20 * 1024 * 1024) { q.state = "failed"; q.message = "Over 20 MB."; drawQueue(); continue; }
      try { q.body = { name: f.name, data: await readB64(f) }; } catch { q.state = "failed"; q.message = "The browser could not read it."; drawQueue(); continue; }
      check(q);
    }
    drawQueue();
  }
  $("memImp").onclick = () => {
    memEditing = null; $("memEditor").hidden = true; $("memText").hidden = true; $("memActions").hidden = true; $("memTagBox").hidden = true;
    $("memImport").hidden = false; $("memPath").textContent = "Import into memory"; drawQueue();
    if (window.matchMedia("(max-width: 860px)").matches) $("h-memview").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("memImpClose").onclick = () => { $("memImport").hidden = true; queue = queue.filter((q) => q.state !== "done"); memMode(false); $("memPath").textContent = memShown || "Pick a memory on the left."; };
  $("memFiles").addEventListener("change", () => { addFiles([...$("memFiles").files]); $("memFiles").value = ""; });
  const drop = $("memDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $("memUrlAdd").onclick = () => {
    const url = $("memUrl").value.trim(); if (!url) { toast("Paste a link first."); return; }
    const q = { label: url, state: "checking", message: "", body: { url } }; queue.push(q); $("memUrl").value = ""; check(q);
  };
  $("memUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("memUrlAdd").click(); } });
  $("memImpGo").onclick = async () => {
    $("memImpGo").disabled = true; let done = 0;
    for (const q of queue.filter((x) => x.state === "ready")) {
      q.state = "importing"; drawQueue();
      let r; try { r = await api("/api/memory/import", Object.assign({}, q.body, { write: true })); } catch { r = { ok: false, error: "The server did not answer." }; }
      q.state = r.ok ? "done" : "failed"; q.message = r.message || r.error || ""; if (r.ok) done++; drawQueue();
    }
    $("memImpNote").textContent = done ? done + " imported." : ""; if (done) { toast(done + " imported."); loadMemories(); }
  };
  // D-093: facts to confirm. A run takes minutes, so it is started and then asked after.
  let factTimer = 0;
  async function loadFacts() {
    clearTimeout(factTimer);
    let r; try { r = await api("/api/distill"); } catch { return; }
    const running = r.run && !r.run.finished;
    const d = r.draft; const list = $("factList"); list.replaceChildren();
    $("factStart").disabled = running;
    if (running) { const mins = Math.max(0, Math.round((Date.now() - Date.parse(r.run.since)) / 60000)); $("factStats").textContent = "(reading — started " + (mins ? mins + " min ago" : "just now") + ")"; if (!$("memories").hidden) factTimer = setTimeout(loadFacts, 10000); }
    else if (r.run && r.run.finished && !r.run.finished.ok) $("factStats").textContent = "(the last run did not finish: " + r.run.finished.message.split("\\n").pop() + ")";
    if (!d) { if (!running) $("factStats").textContent = $("factStats").textContent || ""; list.append(el("p", "empty", running ? "Reading…" : "None yet. “Draw facts…” asks the local model to read your knowledge.")); $("factAdopt").disabled = true; return; }
    const open = d.facts.filter((f) => f.decision === null), yes = d.facts.filter((f) => f.decision === "yes").length;
    if (!running) $("factStats").textContent = "(" + open.length + " to answer · " + yes + " yes · from " + d.sources.length + " note(s), " + d.cut + " cut)";
    $("factAdopt").disabled = yes === 0;
    const shown = [...open, ...d.facts.filter((f) => f.decision !== null)].slice(0, 60);
    for (const f of shown) {
      const row = el("div", "fact" + (f.decision ? " done" : ""));
      const left = el("div"); const t = el("div", "", f.fact); t.append(el("span", "tag", "#" + f.topic)); left.append(t);
      const q = el("div", "q"); q.append(document.createTextNode("“" + f.quote + "” — ")); const src = el("button", "", f.source.path + ":" + f.source.line); src.onclick = () => openMemory(f.source.path); q.append(src); left.append(q);
      const yn = el("div", "yn");
      if (f.decision) yn.append(el("span", "pill " + (f.decision === "yes" ? "act" : "stop"), f.decision));
      else for (const [label, a, cls] of [["Yes", "yes", "primary"], ["No", "no", ""]]) {
        const b = el("button", cls, label);
        b.onclick = async () => { yn.querySelectorAll("button").forEach((x) => x.disabled = true); const out = await api("/api/distill/decide", { fact: f.id, answer: a }); if (!out.ok) toast(out.message || "That did not work."); loadFacts(); };
        yn.append(b);
      }
      row.append(left, yn); list.append(row);
    }
  }
  $("factStart").onclick = async () => {
    const from = memKind === "memory" ? "memory" : "memory/knowledge";
    if (!confirm("Ask the local model to read " + (from === "memory" ? "all of memory" : "your knowledge") + " for facts?\\n\\nIt reads up to 20 pieces on this machine and can take several minutes. Nothing is written until you say yes to a fact and press “Write the yeses”.")) return;
    const r = await api("/api/distill/start", { from });
    toast(r.ok ? "Reading — facts appear here when it is done." : (r.error || "Could not start."));
    loadFacts();
  };
  $("factAdopt").onclick = async () => {
    const plan = await api("/api/distill/adopt", {});
    if (!plan.ok) { toast(plan.message || "Nothing to write."); return; }
    if (!confirm("Write the yeses?\\n\\n" + plan.message + "\\n\\nBoth indexes are rebuilt.")) return;
    const r = await api("/api/distill/adopt", { write: true });
    toast(r.ok ? "Written." : (r.message || "Not written.")); if (r.ok) loadMemories();
  };
  $("memFilter").addEventListener("input", drawMemories);
  $("memType").addEventListener("change", drawMemories);
  // D-152: what /search in the chat says — the summary and its sources as text; the pieces stay on the Memories tab.
  function askSaid(r) {
    if (r.searched === false) return "Nothing was searched: " + (r.error || "there is no index yet and no vector store answered.");
    if (!r.ok && !r.answer) return r.error || "No answer came back.";
    const tick = "\\u0060", from = (r.sources || []).map((s) => tick + s.path + tick + (s.section ? " — " + s.section : "")).join(" · ");
    return (r.answer || "Nothing found.") + (from ? "\\n\\nSources: " + from : "");
  }
  // D-152: search by meaning is a question answered from memory — a short summary and the files it came from,
  // each opening in Read. The pieces it read stay behind "Show the pieces it read", closed until asked.
  function askShown(r) {
    const box = $("memText"); box.replaceChildren(); box.style.whiteSpace = "normal";
    if (r.searched === false) { box.textContent = "Nothing was searched: " + (r.error || "there is no index yet and no vector store answered."); return; }
    if (!r.ok && !r.answer) { box.textContent = r.error || "No answer came back."; return; }
    box.append(md(r.answer || "Nothing found."));
    box.append(el("p", "small", (r.found === 0 ? "Nothing in memory answers this" : "From " + r.found + " piece" + (r.found === 1 ? "" : "s") + " of memory") + (r.backend ? " · answered by " + r.backend + (r.model ? " · " + r.model : "") + (r.local ? " · on this computer" : "") : " · no model was asked")));
    if ((r.sources || []).length) {
      box.append(el("div", "what", "Sources"));
      const list = el("div", "memlist");
      for (const s of r.sources) {
        const b = el("button", "mem"); b.append(el("div", "", s.title || s.path), el("div", "small mono", s.path + (s.section ? " — " + s.section : "")));
        b.onclick = () => openMemory(s.path); list.append(b);
      }
      box.append(list);
    }
    if ((r.pieces || []).length) {
      const d = el("details", "changed"); d.append(el("summary", "", "Show the pieces it read (" + r.pieces.length + ")"));
      for (const p of r.pieces) { const q = el("div", "small"); q.append(el("div", "mono", p.path + (p.section ? " — " + p.section : "")), el("div", "", p.excerpt)); d.append(q); }
      box.append(d);
    }
    if (r.error && r.ok === false) box.append(el("p", "small", r.error));
  }
  $("memSearch").onclick = async () => {
    const q = $("memFilter").value.trim(); if (!q) { toast("Type a question in the box first."); return; }
    $("memSearch").disabled = true; memShown = ""; drawMemories(); $("memPath").textContent = "Asked: " + q; $("memActions").hidden = true; $("memText").hidden = false; $("memText").textContent = "Searching your memory…";
    let r; try { r = await api("/api/memory-ask", { question: q, scope: memKind || "all" }); } catch { r = { ok: false, error: "The server did not answer." }; }
    askShown(r); $("memSearch").disabled = false;
  };
  async function loadSettings() {
    let s; try { s = await api("/api/settings"); } catch { return; }
    $("brakeNote").style.display = s.stopped ? "block" : "none";
    const cats = $("cats"); cats.replaceChildren();
    for (const [key, name, what] of CATS) {
      const now = s.levels[key];
      const row = el("div", "cat");
      const label = el("div"); label.append(el("div", "what", name), el("div", "small", "May it " + what + "?"));
      // D-153: the browser runs at min(operate, reach), and stops for a yes before anything sensitive at every level.
      if (key === "operate" && s.operate) label.append(el("div", "small", "In force: " + s.operate.en + (s.operate.th ? " · " + s.operate.th : "") + ". Paying, sending, deleting, passwords and accepting terms always wait for your yes."));
      const seg = el("div", "seg"); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", name);
      wordsFor(key).forEach((word, level) => {
        const b = el("button", "", word); b.setAttribute("aria-pressed", String(now === level));
        b.onclick = async () => {
          if (now === level) return;
          seg.querySelectorAll("button").forEach((x) => x.disabled = true);
          const r = await api("/api/autonomy", { category: key, level });
          toast(r.ok ? name + ": " + word.toLowerCase() + "." : (r.message || r.error || "That did not work."));
          loadSettings(); refresh();
        };
        seg.append(b);
      });
      const right = el("div"); right.append(seg);
      if (now === 3) right.append(el("span", "lock", key === "operate" ? "now: any site" + (s.operate && s.operate.level === 3 && s.operate.th ? " · " + s.operate.th : "") + " (set in a terminal)" : "now: on its own (set in a terminal)"));
      row.append(label, right); cats.append(row);
    }
    // backend & model
    const sel = $("backendSel"); sel.replaceChildren();
    const def = el("option", "", "Default" + (s.defaultTurn.backend ? " (" + s.defaultTurn.backend + ")" : " (the usual order)")); def.value = ""; sel.append(def);
    for (const b of s.backends) { const o = el("option", "", b.id + (b.available ? "" : " — not found on this computer")); o.value = b.id; o.disabled = !b.available; sel.append(o); }
    const pick = choice(); sel.value = pick.backend; if (sel.value !== pick.backend) sel.value = "";
    $("modelIn").value = pick.model; $("modelIn").placeholder = s.defaultTurn.model ? "default: " + s.defaultTurn.model : "e.g. qwen3.8:27b";
    showModelNow();
    // people & peers
    document.querySelectorAll(".subj").forEach((e) => e.textContent = subject);
    renderList("chatUsers", s.chatUsers, (u) => {
      const li = el("li"); const row = el("div", "row"); row.style.justifyContent = "space-between"; row.style.marginTop = "0";
      const who = el("div"); who.append(el("div", "", (u.label ? u.label + " · " : "") + u.platform + " " + u.userId), el("div", "small", "added " + u.added + " · " + (u.told ? "told it is an AI" : "not written to yet")));
      const rm = el("button", "", "Stop answering");
      rm.onclick = async () => { if (!confirm("Stop answering " + u.platform + " user " + u.userId + "?\\n\\nTheir next message gets no reply. Adding them back is done in a terminal.")) return; rm.disabled = true; const r = await api("/api/chat-users/remove", { platform: u.platform, userId: u.userId }); toast(r.ok ? "Removed." : (r.message || "That did not work.")); loadSettings(); };
      row.append(who, rm); li.append(row); return li;
    }, "Nobody — it answers no one in chat apps.");
    renderList("peers", s.peers, (p) => {
      const li = el("li"); const row = el("div", "row"); row.style.justifyContent = "space-between"; row.style.marginTop = "0";
      const who = el("div"); who.append(el("div", "", p.name), el("div", "small", p.endpoint + " · added " + p.added));
      const rm = el("button", "", "Remove");
      rm.onclick = async () => { if (!confirm("Remove " + p.name + "?\\n\\nIts token stops working both ways. Adding it back is done in a terminal.")) return; rm.disabled = true; const r = await api("/api/peers/remove", { name: p.name }); toast(r.ok ? "Removed." : (r.message || "That did not work.")); loadSettings(); };
      row.append(who, rm); li.append(row); return li;
    }, "No other agents — it talks to none.");
    const g = $("guards"); g.replaceChildren();
    const guard = (name, on, detail) => { const li = el("li"); const t = el("div"); t.append(el("span", "", name + " — "), el("span", on ? "on" : "off", on ? "on" : "off")); li.append(t, el("div", "small", detail)); g.append(li); };
    guard("Personal-word filter", s.guards.needles > 0, s.guards.needles > 0 ? s.guards.needles + " word(s) kept from leaving; plus shapes like phone numbers, always." : "No personal words listed yet — shapes like phone numbers are still caught. List words with mind egress needles.");
    guard("Local judge", !!s.guards.judge, s.guards.judge ? "A model on this computer (" + s.guards.judge + ") reads meaning before a turn or a message to another agent leaves." + (s.guards.needles > 0 ? "" : " It has nothing to read against until personal words are listed.") : "Off. A turn or a message to another agent still goes, with a note each time that only the filter looked. Set MIND_OLLAMA_MODEL (or MIND_EGRESS_JUDGE) to a model on this computer to turn it on; chat apps need MIND_EGRESS_JUDGE.");
    guard("Risk check for suggestions", s.guards.triage, s.guards.triage ? "“Check risk” asks TypeSafe's Jev about a suggestion when you press it." : "Off. It needs a TypeSafe key (TYPESAFE_API_KEY_FILE).");
    try {
      const p = await api("/api/push");
      $("pushLine").hidden = typeof p.count !== "number";
      $("pushLine").textContent = p.count > 0
        ? p.count + " phone(s) are told when something is waiting — through the Mind relay, which learns when, never what."
        : "No phone is told when something is waiting. A phone turns it on in the app.";
    } catch {}
    $("versionLine").textContent = "You have " + s.version.current + (s.version.latest ? " · newest published " + s.version.latest : "") + (s.version.checked ? " · checked " + s.version.checked : "");
  }
  let subject = "";
  function showModelNow() { const p = choice(); $("modelNow").textContent = p.backend || p.model ? "Using " + (p.backend || "the default backend") + (p.model ? " · " + p.model : "") : "Using the default."; }
  $("saveModel").onclick = () => { store.set("mind-backend", $("backendSel").value); store.set("mind-model", $("modelIn").value.trim()); showModelNow(); syncPicker(); toast("Saved for this browser."); };
  $("rotateKey").onclick = async () => {
    if (!confirm("Change this page's key?\\n\\nEvery paired phone, every other open tab and every saved link stop working, bookmarks included. This tab keeps working.")) return;
    $("rotateKey").disabled = true;
    let r; try { r = await api("/api/pair/rotate", { origin: location.origin }); } catch { $("rotateKey").disabled = false; return; }
    $("rotateKey").disabled = false;
    if (!r.ok) { toast(r.error || "The key was not changed."); return; }
    token = r.token; webKeep.set(sessionStorage, "mind-t", token);
    toast(r.warning ? r.warning : "Every phone is unpaired" + (r.unsubscribed > 0 ? " and no longer notified" : "") + ". Pair again with the new code."); loadSettings();
    if (!$("pairBox").hidden) $("showPair").click();
  };
  $("showPair").onclick = async () => {
    $("showPair").disabled = true;
    let r; try { r = await api("/api/pair?origin=" + encodeURIComponent(location.origin)); } catch { $("showPair").disabled = false; return; }
    $("showPair").disabled = false;
    if (!r.code) { toast(r.error || "Could not make the code."); return; }
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), bg = document.createElementNS(NS, "rect"), path = document.createElementNS(NS, "path");
    svg.setAttribute("viewBox", "0 0 " + r.code.size + " " + r.code.size); svg.setAttribute("shape-rendering", "crispEdges"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Pairing code for the Mind app");
    bg.setAttribute("width", r.code.size); bg.setAttribute("height", r.code.size); bg.setAttribute("fill", "#fff"); path.setAttribute("fill", "#000"); path.setAttribute("d", r.code.d);
    svg.append(bg, path); $("pairCode").replaceChildren(svg); $("pairBox").hidden = false; $("showPair").hidden = true; $("hidePair").hidden = false;
  };
  $("hidePair").onclick = () => { $("pairCode").replaceChildren(); $("pairBox").hidden = true; $("showPair").hidden = false; $("hidePair").hidden = true; };
  $("checkUpdate").onclick = async () => { $("checkUpdate").disabled = true; const r = await api("/api/update-check", {}); toast(r.message || (r.ok ? "Checked." : "Could not check.")); $("checkUpdate").disabled = false; loadSettings(); };
  pickSummary(); loadModels();
  // ── Tasks (D-154) ── the same API the app uses: /api/tasks, one task, its newest screenshot, stop and resume.
  let taskOpen = null;
  const TASK_WORDS = { planning: "Planning", running: "Working on it", waiting: "Waiting for you", "waiting-backend": "Waiting for its backend", parked: "Parked", done: "Done", failed: "Failed", stopped: "Stopped", budget: "Out of budget", interrupted: "Interrupted" };
  const taskWord = (t) => (TASK_WORDS[t.status] || t.status) + " · " + t.used.turns + "/" + t.budget.turns + " turns";
  async function loadTasks() {
    let r; try { r = await api("/api/tasks"); } catch { return; }
    const box = $("taskList"); box.replaceChildren();
    const items = r.tasks || [];
    if (!items.length) box.append(el("p", "empty", "No tasks yet."));
    for (const t of items) {
      const c = el("div", "card"); c.tabIndex = 0; c.setAttribute("role", "button"); c.style.cursor = "pointer";
      c.append(el("p", "what", t.goal), el("p", "meta", taskWord(t) + (t.reason ? " — " + t.reason : "")));
      // D-158: resuming is yours to do — an interrupted task says so where it is listed, with the button.
      if (t.resumable) {
        c.style.borderColor = "hsl(var(--destructive))";
        c.append(el("p", "meta", t.status === "parked" ? "It was set aside (see why above). Resume carries it on; Stop ends it." : "Its runner stopped mid-way (a crash or a restart). Nothing resumes it on its own."));
        const b = el("button", "primary", "Resume");
        b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; const r = await api("/api/tasks/" + t.id + "/resume", {}); toast(r.ok ? "Resumed in the background." : (r.message || "That did not work.")); loadTasks(); };
        c.append(b);
      }
      c.onclick = () => { taskOpen = t.id; drawTask(); };
      c.onkeydown = (e) => { if (e.key === "Enter") c.onclick(); };
      box.append(c);
    }
    if (taskOpen) drawTask();
  }
  async function drawTask() {
    const d = $("taskDetail");
    if (!taskOpen) { d.hidden = true; return; }
    let t; try { t = await api("/api/tasks/" + taskOpen); } catch { return; }
    if (t.error) { d.hidden = false; d.replaceChildren(el("p", "small", t.error)); return; }
    d.hidden = false; d.replaceChildren();
    d.append(el("h2", "", t.goal), el("p", "meta", taskWord(t) + (t.reason ? " — " + t.reason : "") + " · " + (t.used.activeMs / 60000).toFixed(1) + "/" + t.budget.minutes + " min"));
    if (t.plan && t.plan.length) { const ol = el("ol", "small"); for (const p of t.plan) ol.append(el("li", "", p)); d.append(el("p", "small", "Plan"), ol); }
    const log = el("ul", "plain small");
    for (const st of t.steps) {
      const li = el("li");
      li.append(el("div", "", (st.kind === "plan" ? "Plan" : "Step " + st.n) + " — " + (st.finishedAt === null ? "running" : st.outcome) + (st.waitedMs > 0 ? " · waited " + Math.round(st.waitedMs / 1000) + "s for you" : "")));
      if (st.summary) li.append(el("div", "hint", st.summary));
      log.append(li);
    }
    d.append(el("p", "small", "Steps"), log);
    const asks = (t.approvals || []);
    if (asks.length) {
      d.append(el("p", "small", "Sensitive actions it asked about"));
      for (const a of asks) d.append(a.status === "pending" ? askCard(a, t.id) : el("p", "hint", heldWords(a) + " — " + (a.status === "refused" || a.approvable === false ? "not allowed yet (D-160): a password or credential is never entered for you until a store fills it without the model seeing it" : a.status + (a.by ? " (" + a.by + ")" : ""))));
    }
    if (t.result) { const res = el("div", "notes"); res.style.whiteSpace = "normal"; res.append(md(t.result)); d.append(el("p", "small", "Result"), res); }
    if (t.operate > 0) {
      const img = el("img"); img.alt = "The task's browser, as it last looked"; img.style.maxWidth = "100%"; img.style.border = "1px solid hsl(var(--border))"; img.style.borderRadius = "8px";
      const cap = el("p", "hint", "Its browser: loading the newest screenshot…");
      d.append(cap, img);
      api("/api/tasks/" + t.id + "/screen").then((r) => { if (r.image) { img.src = r.image; cap.textContent = "Its browser, " + new Date(r.at).toLocaleTimeString() + (t.status === "running" || t.status === "waiting" ? " (live — it refreshes)" : ""); } else { img.remove(); cap.textContent = "Its browser: " + (r.error || "no screenshot yet"); } }).catch(() => {});
    }
    const row = el("div", "row");
    if (t.stoppable && t.status !== "interrupted") { const b = el("button", "danger", "Stop this task"); b.onclick = async () => { b.disabled = true; const r = await api("/api/tasks/" + t.id + "/stop", {}); toast(r.ok ? "Stopped." : (r.message || "That did not work.")); loadTasks(); }; row.append(b); }
    if (t.resumable) { const b = el("button", "primary", "Resume"); b.onclick = async () => { b.disabled = true; const r = await api("/api/tasks/" + t.id + "/resume", {}); toast(r.ok ? "Resumed in the background." : (r.message || "That did not work.")); loadTasks(); }; row.append(b); }
    const close = el("button", "", "Close"); close.onclick = () => { taskOpen = null; drawTask(); }; row.append(close);
    d.append(row);
  }
  // D-156 — the held actions a task is paused on: one card each, answered once (the engine's own claim).
  const answering = new Set();
  function heldWords(a) {
    const x = a.action || {};
    const what = x.kind === "dialog-submit" ? "accept a dialog" : x.kind === "dialog-type" ? "answer a dialog" : (x.kind || "act");
    const target = (x.formAction ? " → " + String(x.formMethod || "get").toUpperCase() + " " + x.formAction : "") + (x.href ? " → " + x.href : "") + (x.context ? " (in: “" + x.context + "”)" : "");
    return what + (x.text ? " “" + x.text + "”" : "") + target + (x.origin ? " on " + x.origin + (x.path || "") : "") + (x.frameOrigin ? " (in a frame from " + x.frameOrigin + (x.framePath || "") + ")" : "");
  }
  function askCard(a, taskId) {
    const c = el("div", "card"); c.style.borderColor = "hsl(var(--destructive))";
    // D-159: a page's confirm is its own question, shown with the action that opened it.
    if (a.follows) c.append(el("p", "meta", "1. You allowed: " + heldWords(a.follows)), el("p", "meta", "2. Now the page asks:"));
    c.append(el("p", "what", "It wants to " + heldWords(a)), el("p", "meta", (a.reasons || []).join(" · ")));
    if (a.carriesValue) c.append(el("p", "meta", "The value is not shown, and was chosen by the agent."));
    c.append(el("p", "meta", (a.goal ? "Task: " + a.goal + " · " : "") + "answer before " + new Date(a.expiresAt).toLocaleTimeString()));
    const busy = answering.has(a.id);
    // D-160: a credential cannot be approved, from anywhere — the engine refuses it too.
    const yes = el("button", "primary", a.approvable === false ? "Not allowed yet (D-160)" : busy ? "Answering…" : "Yes, this once"); const no = el("button", "", "No"); const stop = el("button", "danger", "No, and stop the task");
    yes.disabled = no.disabled = stop.disabled = busy;
    if (a.approvable === false) yes.disabled = true;
    const go = async (verdict, body) => {
      answering.add(a.id); yes.disabled = no.disabled = stop.disabled = true;
      let r; try { r = await api("/api/tasks/" + taskId + "/approvals/" + a.id + "/" + verdict, body); } finally { answering.delete(a.id); }
      toast(r && r.ok ? (verdict === "approve" ? "Allowed — it happens once, now." : "Declined — the task is told.") : ((r && (r.reason || r.error)) || "That did not work."));
      refresh(true); loadTasks();
    };
    yes.onclick = () => go("approve", {}); no.onclick = () => go("deny", {}); stop.onclick = () => go("deny", { stop: true });
    const row = el("div", "row"); row.append(yes, no, stop); c.append(row);
    return c;
  }
  function renderTaskAsks(items) {
    items = items || [];
    $("taskAskBox").hidden = items.length === 0;
    const box = $("taskAsk"); box.replaceChildren();
    for (const a of items) box.append(askCard(a, a.task));
    const tab = $("tabTasks").querySelector("span"); tab.textContent = items.length ? "Tasks (" + items.length + ")" : "Tasks";
  }
  $("taskStart").onclick = async () => {
    const goal = $("taskGoal").value.trim(); if (!goal) { toast("Write the goal first."); return; }
    const body = { goal, operate: Number($("taskOperate").value) };
    const allow = $("taskAllow").value.split(/[\s,]+/).filter(Boolean); if (allow.length) body.allow = allow;
    const backend = $("taskBackend").value.trim(); if (backend) body.backend = backend;
    if ($("taskTurns").value) body.budgetTurns = Number($("taskTurns").value);
    if ($("taskMinutes").value) body.budgetMinutes = Number($("taskMinutes").value);
    $("taskStart").disabled = true;
    let r; try { r = await api("/api/tasks", body); } finally { $("taskStart").disabled = false; }
    if (!r || !r.ok) { toast((r && r.error) || "It did not start."); return; }
    toast("Started " + r.id + "."); $("taskGoal").value = ""; taskOpen = r.id; loadTasks();
  };
  setInterval(() => { if (!$("tasks").hidden) loadTasks(); }, 4000);
  refresh().then(() => { if (startTab !== "home") showTab(startTab); }); setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
