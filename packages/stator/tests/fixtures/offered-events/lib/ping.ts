import { dispatch } from '../../../../src/client/index.ts'
import Cart from '../machines/cart.ts'

export const ping = () => dispatch(Cart, { type: 'PING' })
