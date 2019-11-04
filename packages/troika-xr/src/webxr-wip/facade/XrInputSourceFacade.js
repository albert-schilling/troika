import { Group3DFacade, Object3DFacade } from 'troika-3d'
import { Facade, utils } from 'troika-core'
import { Matrix4, Ray } from 'three'
import CursorFacade from './CursorFacade'
import TargetRayFacade from './TargetRayFacade'
import GripFacade from './GripFacade'
import { BUTTON_SQUEEZE, BUTTON_TRIGGER } from '../xrStandardGamepadMapping'

const SCENE_EVENTS = ['mousemove', 'mouseover', 'mouseout', 'mousedown', 'mouseup', 'click']
const XRSESSION_EVENTS = ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend']
const CLICK_MAX_DUR = 300

const HAPTICS = { //TODO allow control
  mouseover: {value: 0.3, duration: 10},
  click: {value: 1, duration: 20}
}

const DEFAULT_CURSOR = {
  facade: CursorFacade
}
const DEFAULT_TARGET_RAY = {
  facade: TargetRayFacade
}
const DEFAULT_GRIP = {
  facade: GripFacade
}

function toggleEvents (target, on, eventTypes, handler) {
  if (target) {
    eventTypes.forEach(type => {
      target[`${on ? 'add' : 'remove'}EventListener`](type, handler)
    })
  }
}

const tempMat4 = new Matrix4()

/**
 * Controls the behavior and visual representation of a single XRInputSource.
 *
 * |                   | Highlight | Cursor | Pointing Ray | Renderable Model |
 * | ------------------| --------- | ------ | ------------ | ---------------- |
 * | 'screen'          | √         | X      | X            | X                |
 * | 'gaze'            | √         | √      | X            | X                |
 * | 'tracked-pointer' | √         | √      | √            | √ (if possible)  |
 */
class XrInputSourceFacade extends Group3DFacade {
  constructor (parent) {
    super(parent)

    // Required props
    this.xrInputSource = null
    this.xrSession = null
    this.xrReferenceSpace = null

    // Current frame state data, passed to all children:
    this.targetRayPose = null
    this.gripPose = null
    this.rayIntersection = null

    // Child object configs:
    this.cursor = utils.assign(DEFAULT_CURSOR)
    this.targetRay = utils.assign(DEFAULT_TARGET_RAY)
    this.grip = utils.assign(DEFAULT_GRIP)

    // Pointing - true for all inputs by default
    this.isPointing = true

    this.children = [
      null, //cursor
      null, //targetRay
      null //grip
    ]

    this._ray = new Ray()

    this._onSessionEvent = this._onSessionEvent.bind(this)
    this._onSceneRayEvent = this._onSceneRayEvent.bind(this)
    this.addEventListener('xrframe', this._onXrFrame.bind(this))

    // Listen to ray intersection related events at the scene level, so we can respond to intersection changes
    toggleEvents(this.getSceneFacade(), true, SCENE_EVENTS, this._onSceneRayEvent)
  }

  afterUpdate () {
    const {xrSession, _lastXrSession, xrInputSource, rayIntersection, children, isPointing, cursor, targetRay, grip, targetRayPose, gripPose} = this

    if (xrSession !== _lastXrSession) {
      this._lastXrSession = xrSession
      toggleEvents(_lastXrSession, false, XRSESSION_EVENTS, this._onSessionEvent)
      // Only listen for XRSession 'select' event if we won't be handling the xr-standard
      // gamepad button tracking ourselves
      if (!this._isXrStandardGamepad()) {
        toggleEvents(xrSession, true, XRSESSION_EVENTS, this._onSessionEvent)
      }
    }

    // Update child objects
    let cursorCfg = null, targetRayCfg = null, gripCfg = null
    if (xrInputSource.targetRayMode !== 'screen') {
      cursorCfg = isPointing && cursor
      if (cursorCfg) {
        cursorCfg.key = 'cursor'
        cursorCfg.targetRayPose = targetRayPose
        cursorCfg.gripPose = gripPose
        cursorCfg.rayIntersection = rayIntersection
        cursorCfg.xrInputSource = xrInputSource
      }
    }
    if (xrInputSource.targetRayMode === 'tracked-pointer') {
      targetRayCfg = isPointing && targetRay
      if (targetRayCfg) {
        targetRayCfg.key = 'targetRay'
        targetRayCfg.targetRayPose = targetRayPose
        targetRayCfg.gripPose = gripPose
        targetRayCfg.rayIntersection = rayIntersection
        targetRayCfg.xrInputSource = xrInputSource
      }
      gripCfg = gripPose ? grip : null
      if (gripCfg) {
        gripCfg.key = 'grip'
        gripCfg.targetRayPose = targetRayPose
        gripCfg.gripPose = gripPose
        gripCfg.rayIntersection = rayIntersection
        gripCfg.xrInputSource = xrInputSource
      }
    }
    children[0] = cursorCfg
    children[1] = targetRayCfg
    children[2] = gripCfg

    super.afterUpdate()
  }

  _onXrFrame (time, xrFrame) {
    // TODO offset the ref space the same way as the camera (?)
    const {xrInputSource, isPointing, _ray: ray} = this
    const offsetReferenceSpace = this.getCameraFacade().offsetReferenceSpace

    if (offsetReferenceSpace) {
      // Update current poses
      const {targetRaySpace, gripSpace} = xrInputSource
      const targetRayPose = xrFrame.getPose(targetRaySpace, offsetReferenceSpace)
      if (targetRayPose && isPointing) {
        ray.origin.copy(targetRayPose.transform.position)
        ray.direction.set(0, 0, -1).applyQuaternion(targetRayPose.transform.orientation)
        this.notifyWorld('rayPointerMotion', ray)
      }
      this.targetRayPose = targetRayPose
      this.gripPose = gripSpace ? xrFrame.getPose(gripSpace, offsetReferenceSpace) : null
    }

    // If this is a tracked-pointer with a gamepad, track its button/axis states
    if (this._isXrStandardGamepad()) {
      this._trackGamepadState(xrInputSource.gamepad)
    }

    this.afterUpdate()
  }

  _isXrStandardGamepad() {
    const {gamepad} = this.xrInputSource
    return gamepad && gamepad.mapping === 'xr-standard'
  }

  _trackGamepadState(gamepad) {
    // Handle button presses
    const buttons = gamepad.buttons
    const pressedTimes = this._buttonPresses || (this._buttonPresses = [])
    const now = Date.now()
    const ray = this._ray //assumes already updated to current frame pose
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i].pressed !== !!pressedTimes[i]) {
        if (this.isPointing) {
          this.notifyWorld('rayPointerAction', {
            ray,
            type: buttons[i].pressed ? 'mousedown' : 'mouseup',
            button: i
          })
          if (pressedTimes[i] && !buttons[i].pressed && now - pressedTimes[i] <= CLICK_MAX_DUR) {
            this.notifyWorld('rayPointerAction', {
              ray,
              type: 'click',
              button: i
            })
          }
        }
        pressedTimes[i] = buttons[i].pressed ? now : null
      }
      pressedTimes.length = buttons.length
    }

    // Handle axis inputs
    const axes = gamepad.axes
    for (let i = 0; i < axes.length; i += 2) {
      // Map each pair of axes to wheel event deltaX/Y
      // TODO investigate better mapping
      const deltaX = (axes[i] || 0) * 10
      const deltaY = (axes[i + 1] || 0) * 10
      if (Math.hypot(deltaX, deltaY) > 0.1) {
        if (this.isPointing) {
          this.notifyWorld('rayPointerAction', {
            ray,
            type: 'wheel',
            deltaX,
            deltaY,
            deltaMode: 0 //pixel mode
          })
        }
      }
    }
  }

  _onSessionEvent (e) {
    // Redispatch select and squeeze events as standard pointer events to the world's event system.
    // Note this is only used for non xr-standard gamepad inputs, otherwise it's handled in the
    // gamepad button state tracking.
    this.notifyWorld('rayPointerAction', {
      ray: this._ray,
      type: /start$/.test(e.type) ? 'mousedown' : /end$/.test(e.type) ? 'mouseup' : 'click',
      button: /^squeeze/.test(e.type) ? BUTTON_SQUEEZE : BUTTON_TRIGGER
    })
  }

  _onSceneRayEvent (e) {
    // Only handle events where this was the ray's source
    if (e.nativeEvent.eventSource === this) {
      // Copy intersection info to local state and update subtree
      this.rayIntersection = e.intersection
      this.afterUpdate()

      // If haptics available, trigger a pulse
      const isScene = e.target === e.currentTarget
      const hapticPulse = e.type === 'click' ? HAPTICS.click
        : (e.type === 'mouseover' && !isScene) ? HAPTICS.mouseover
        : null
      if (hapticPulse) {
        const {gamepad} = this.xrInputSource
        const hapticActuator = gamepad && gamepad.hapticActuators && gamepad.hapticActuators[0]
        if (hapticActuator) {
          hapticActuator.pulse(hapticPulse.value || 1, hapticPulse.duration || 100)
        }
      }

      // For certain events, dispatch an xr-specific event to the raycast target:
      const xrTargetEvent = RAY_TARGET_EVENTS[e.button] && RAY_TARGET_EVENTS[e.button][e.type]
      if (xrTargetEvent) {
        const event = new Event(xrTargetEvent, {bubbles: true})
        event.eventSource = this
        e.target.dispatchEvent(event)
      }
    }
  }

  destructor () {
    toggleEvents(this.xrSession, false, XRSESSION_EVENTS, this._onSessionEvent)
    toggleEvents(this.getSceneFacade(), false, SCENE_EVENTS, this._onSceneRayEvent)
    super.destructor()
  }
}

// this.onXrFrame = null //timestamp, XRFrame
// this.onIntersectionEvent = null //???
// this.onSelectStart = null
// this.onSelect = null
// this.onSelectEnd = null
// this.onSqueezeStart = null
// this.onSqueeze = null
// this.onSqueezeEnd = null
// this.onButtonTouchStart = null
// this.onButtonPressStart = null
// this.onButtonPress = null
// this.onButtonPressEnd = null
// this.onButtonTouchEnd = null


// Define some custom xr-specific events that will be dispatched to the target Object3DFacade
// intersecting the ray at the time of a button action:
const RAY_TARGET_EVENTS = {
  [BUTTON_TRIGGER]: {
    mousedown: 'xrselectstart',
    mouseup: 'xrselectend',
    click: 'xrselect'
  },
  [BUTTON_SQUEEZE]: {
    mousedown: 'xrsqueezestart',
    mouseup: 'xrsqueezeend',
    click: 'xrsqueeze'
  }
}

// ...and add shortcut event handler properties on Object3DFacade for those events:
Facade.defineEventProperty(Object3DFacade, 'onXRSelectStart', 'xrselectstart')
Facade.defineEventProperty(Object3DFacade, 'onXRSelect', 'xrselect')
Facade.defineEventProperty(Object3DFacade, 'onXRSelectEnd', 'xrselectend')
Facade.defineEventProperty(Object3DFacade, 'onXRSqueezeStart', 'xrsqueezestart')
Facade.defineEventProperty(Object3DFacade, 'onXRSqueeze', 'xrsqueeze')
Facade.defineEventProperty(Object3DFacade, 'onXRSqueezeEnd', 'xrsqueezeend')


export default XrInputSourceFacade
