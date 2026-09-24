export const PINE_EXAMPLE = `//@version=5
indicator(title='均线系统', shorttitle='均', overlay=true)
sma20 = ta.sma(close, 20)
sma60 = ta.sma(close, 60)
sma120 = ta.sma(close, 120)

ema20 = ta.ema(close, 20)
ema60 = ta.ema(close, 60)
ema120 = ta.ema(close, 120)

plot(sma20, color=color.new(color.yellow, 0), title='SMA20')
plot(ema20, color=color.new(color.yellow, 50), title='EMA20')

plot(sma60, color=color.new(color.blue, 0), title='SMA60')
plot(ema60, color=color.new(color.blue, 50), title='EMA60')

plot(sma120, color=color.new(color.red, 0), title='SMA120')
plot(ema120, color=color.new(color.red, 50), title='EMA120')

cond = barstate.islast
bl = low
moveBar = input(0)
x20 = input(20) + moveBar
x60 = input(60) + moveBar
x120 = input(120) + moveBar
plot(cond ? bl[20] : na, color=color.new(#FFC40C, 0), linewidth=5, offset=-x20, style=plot.style_circles)
plot(cond ? bl[60] : na, color=color.new(#FFC40C, 0), linewidth=5, offset=-x60, style=plot.style_circles)
plot(cond ? bl[120] : na, color=color.new(#FFC40C, 0), linewidth=5, offset=-x120, style=plot.style_circles)`
