import { defineApiRoute } from '@statorjs/stator/server'
import { instanceId } from '../lib/instance.ts'

export const GET = defineApiRoute({
  method: 'GET',
  handler: () => ({ id: instanceId }),
})
