import { FutuPaper } from '@/components/FutuPaper'
import { Card, CardTitle } from '@/components/ui'

export function FuturePaperSection() {
  return (
    <>
      <Card className="flex flex-col gap-2 p-[18px] text-[13px] text-ink-2">
        <CardTitle>券商连接 · 富途模拟盘</CardTitle>
        <p className="m-0">可选：通过本机富途 OpenD，在真实的富途 SIMULATE 账户里执行受限额约束的委托。和工作台的模拟交易所互不影响。实盘接口不在这一版里，以后接券商时只换执行这一层。</p>
      </Card>
      <FutuPaper />
    </>
  )
}
