import { Color, Vector2, NearestFilter, Matrix4, RendererUtils, PassNode, QuadMesh, NodeMaterial } from 'three/webgpu';
import { add, float, If, Loop, int, Fn, min, max, clamp, nodeObject, texture, uniform, uv, vec2, vec4, luminance, output, mrt, textureLoad, screenCoordinate } from 'three/tsl';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();

let _rendererState;


/**
 * A special render pass node that renders the scene with TRAA (Temporal Reprojection Anti-Aliasing).
 *
 * Note: The current implementation does not yet support MRT setups.
 *
 * References:
 * - {@link https://alextardif.com/TAA.html}
 * - {@link https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/}
 *
 * @augments PassNode
 * @three_import import { traaPass } from 'three/addons/tsl/display/TRAAPassNode.js';
 */
class TRAAPassNode extends PassNode {

	static get type() {

		return 'TRAAPassNode';

	}

	/**
	 * Constructs a new TRAA pass node.
	 *
	 * @param {Scene} scene - The scene to render.
	 * @param {Camera} camera - The camera to render the scene with.
	 */
	constructor( scene, camera ) {

		super( PassNode.COLOR, scene, camera );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isTRAAPassNode = true;

		/**
		 * The clear color of the pass.
		 *
		 * @type {Color}
		 * @default 0x000000
		 */
		this.clearColor = new Color( 0x000000 );

		/**
		 * The clear alpha of the pass.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.clearAlpha = 0;

		/**
		 * The jitter index selects the current camera offset value.
		 *
		 * @private
		 * @type {number}
		 * @default 0
		 */
		this._jitterIndex = 0;

		/**
		 * Used to save the original/unjittered projection matrix.
		 *
		 * @private
		 * @type {Matrix4}
		 */
		this._originalProjectionMatrix = new Matrix4();

		/**
		 * A uniform node holding the inverse resolution value.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._invSize = uniform( new Vector2() );

		/**
		 * The render target that holds the current sample.
		 *
		 * @private
		 * @type {?RenderTarget}
		 * @default null
		 */
		this._sampleRenderTarget = null;

		/**
		 * The render target that represents the history of frame data.
		 *
		 * @private
		 * @type {?RenderTarget}
		 * @default null
		 */
		this._historyRenderTarget = null;

		/**
		 * The MRT for the transfer step.
		 *
		 * @private
		 * @type {?MRTNode}
		 * @default null
		 */
		this._transferMRT = null;

		/**
		 * Material used for the resolve step.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._resolveMaterial = new NodeMaterial();
		this._resolveMaterial.name = 'TRAA.Resolve';

	}

	/**
	 * Sets the size of the effect.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 * @return {boolean} Whether the TRAA needs a restart or not. That is required after a resize since buffer data with different sizes can't be resolved.
	 */
	setSize( width, height ) {

		super.setSize( width, height );

		let needsRestart = false;

		if ( this.renderTarget.width !== this._sampleRenderTarget.width || this.renderTarget.height !== this._sampleRenderTarget.height ) {

			this._sampleRenderTarget.setSize( this.renderTarget.width, this.renderTarget.height );
			this._historyRenderTarget.setSize( this.renderTarget.width, this.renderTarget.height );

			this._invSize.value.set( 1 / this.renderTarget.width, 1 / this.renderTarget.height );

			needsRestart = true;

		}

		return needsRestart;

	}

	/**
	 * This method is used to render the effect once per frame.
	 *
	 * @param {NodeFrame} frame - The current node frame.
	 */
	updateBefore( frame ) {

		const { renderer } = frame;
		const { scene, camera } = this;

		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		//

		this._pixelRatio = renderer.getPixelRatio();
		const size = renderer.getSize( _size );

		const needsRestart = this.setSize( size.width, size.height );

		// save original/unjittered projection matrix for velocity pass

		camera.updateProjectionMatrix();
		this._originalProjectionMatrix.copy( camera.projectionMatrix );

		// camera configuration

		this._cameraNear.value = camera.near;
		this._cameraFar.value = camera.far;

		// configure jitter as view offset

		const viewOffset = {

			fullWidth: this.renderTarget.width,
			fullHeight: this.renderTarget.height,
			offsetX: 0,
			offsetY: 0,
			width: this.renderTarget.width,
			height: this.renderTarget.height

		};

		const originalViewOffset = Object.assign( {}, camera.view );

		if ( originalViewOffset.enabled ) Object.assign( viewOffset, originalViewOffset );

		const jitterOffset = _JitterVectors[ this._jitterIndex ];

		camera.setViewOffset(

			viewOffset.fullWidth, viewOffset.fullHeight,

			viewOffset.offsetX + jitterOffset[ 0 ] * 0.0625, viewOffset.offsetY + jitterOffset[ 1 ] * 0.0625, // 0.0625 = 1 / 16

			viewOffset.width, viewOffset.height

		);

		// configure velocity

		const currentMRT = this.getMRT();
		const velocityOutput = currentMRT.get( 'velocity' );

		velocityOutput.setProjectionMatrix( this._originalProjectionMatrix );

		// render sample

		renderer.setMRT( currentMRT );

		renderer.setClearColor( this.clearColor, this.clearAlpha );
		renderer.setRenderTarget( this._sampleRenderTarget );
		renderer.render( scene, camera );

		renderer.setRenderTarget( null );
		renderer.setMRT( this._transferMRT );

		// every time when the dimensions change we need fresh history data. Copy the sample
		// into the history and final render target (no AA happens at that point).

		if ( needsRestart === true ) {

			// bind and clear render target to make sure they are initialized after the resize which triggers a dispose()

			renderer.setRenderTarget( this._historyRenderTarget );
			renderer.clear();

			renderer.setRenderTarget( this.renderTarget );
			renderer.clear();

			renderer.setRenderTarget( null );

			renderer.copyTextureToTexture( this._sampleRenderTarget.texture, this._historyRenderTarget.texture );
			renderer.copyTextureToTexture( this._sampleRenderTarget.texture, this.renderTarget.texture );

		} else {

			// resolve

			renderer.setRenderTarget( this.renderTarget );
			_quadMesh.material = this._resolveMaterial;
			_quadMesh.render( renderer );
			renderer.setRenderTarget( null );

			// update history

			renderer.copyTextureToTexture( this.renderTarget.texture, this._historyRenderTarget.texture );

		}

		// copy depth

		renderer.copyTextureToTexture( this._sampleRenderTarget.depthTexture, this.renderTarget.depthTexture );

		// update jitter index

		this._jitterIndex ++;
		this._jitterIndex = this._jitterIndex % ( _JitterVectors.length - 1 );

		// restore

		if ( originalViewOffset.enabled ) {

			camera.setViewOffset(

				originalViewOffset.fullWidth, originalViewOffset.fullHeight,

				originalViewOffset.offsetX, originalViewOffset.offsetY,

				originalViewOffset.width, originalViewOffset.height

			);

		} else {

			camera.clearViewOffset();

		}

		velocityOutput.setProjectionMatrix( null );

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	/**
	 * This method is used to setup the effect's render targets and TSL code.
	 *
	 * @param {NodeBuilder} builder - The current node builder.
	 * @return {PassTextureNode}
	 */
	setup( builder ) {

		if ( this._sampleRenderTarget === null ) {

			this._sampleRenderTarget = this.renderTarget.clone();
			this._historyRenderTarget = this.renderTarget.clone();

			this._sampleRenderTarget.texture.minFiler = NearestFilter;
			this._sampleRenderTarget.texture.magFilter = NearestFilter;

			const currentMRT = this.getMRT();

			if ( currentMRT === null ) {

				throw new Error( 'THREE:TRAAPassNode: Missing MRT configuration.' );

			} else if ( currentMRT.has( 'velocity' ) === false ) {

				throw new Error( 'THREE:TRAAPassNode: Missing velocity output in MRT configuration.' );

			}

			this._texturesIndex = currentMRT.getIndexes( this.renderTarget );
			
			const transferNodes = {};

			for ( const name in this._texturesIndex ) {

				if ( name === 'output' ) {

					transferNodes[ name ] = output;

				} else {

					const index = this._texturesIndex[ name ];

					transferNodes[ name ] = textureLoad( this._sampleRenderTarget.textures[ index ], screenCoordinate );

				}

			}

			this._transferMRT = mrt( transferNodes );

		}

		// textures

		const velocityIndex = this._texturesIndex[ 'velocity' ];

		const historyTexture = texture( this._historyRenderTarget.texture );
		const sampleTexture = texture( this._sampleRenderTarget.textures[ 0 ] );
		const velocityTexture = texture( this._sampleRenderTarget.textures[ velocityIndex ] );
		const depthTexture = texture( this._sampleRenderTarget.depthTexture );

		const resolve = Fn( () => {

			const uvNode = uv();

			const minColor = vec4( 10000 ).toVar();
			const maxColor = vec4( - 10000 ).toVar();
			const closestDepth = float( 1 ).toVar();
			const closestDepthPixelPosition = vec2( 0 ).toVar();

			// sample a 3x3 neighborhood to create a box in color space
			// clamping the history color with the resulting min/max colors mitigates ghosting

			Loop( { start: int( - 1 ), end: int( 1 ), type: 'int', condition: '<=', name: 'x' }, ( { x } ) => {

				Loop( { start: int( - 1 ), end: int( 1 ), type: 'int', condition: '<=', name: 'y' }, ( { y } ) => {

					const uvNeighbor = uvNode.add( vec2( float( x ), float( y ) ).mul( this._invSize ) ).toVar();
					const colorNeighbor = max( vec4( 0 ), sampleTexture.sample( uvNeighbor ) ).toVar(); // use max() to avoid propagate garbage values

					minColor.assign( min( minColor, colorNeighbor ) );
					maxColor.assign( max( maxColor, colorNeighbor ) );

					const currentDepth = depthTexture.sample( uvNeighbor ).r.toVar();

					// find the sample position of the closest depth in the neighborhood (used for velocity)

					If( currentDepth.lessThan( closestDepth ), () => {

						closestDepth.assign( currentDepth );
						closestDepthPixelPosition.assign( uvNeighbor );

					} );

				} );

			} );

			// sampling/reprojection

			const offset = velocityTexture.sample( closestDepthPixelPosition ).xy.mul( vec2( 0.5, - 0.5 ) ); // NDC to uv offset

			const currentColor = sampleTexture.sample( uvNode );
			const historyColor = historyTexture.sample( uvNode.sub( offset ) );

			// clamping

			const clampedHistoryColor = clamp( historyColor, minColor, maxColor );

			// flicker reduction based on luminance weighing

			const currentWeight = float( 0.05 ).toVar();
			const historyWeight = currentWeight.oneMinus().toVar();

			const compressedCurrent = currentColor.mul( float( 1 ).div( ( max( currentColor.r, currentColor.g, currentColor.b ).add( 1.0 ) ) ) );
			const compressedHistory = clampedHistoryColor.mul( float( 1 ).div( ( max( clampedHistoryColor.r, clampedHistoryColor.g, clampedHistoryColor.b ).add( 1.0 ) ) ) );

			const luminanceCurrent = luminance( compressedCurrent.rgb );
			const luminanceHistory = luminance( compressedHistory.rgb );

			currentWeight.mulAssign( float( 1.0 ).div( luminanceCurrent.add( 1 ) ) );
			historyWeight.mulAssign( float( 1.0 ).div( luminanceHistory.add( 1 ) ) );

			return add( currentColor.mul( currentWeight ), clampedHistoryColor.mul( historyWeight ) ).div( max( currentWeight.add( historyWeight ), 0.00001 ) );

		} );

		// materials

		this._resolveMaterial.colorNode = resolve();

		return super.setup( builder );

	}

	/**
	 * Frees internal resources. This method should be called
	 * when the effect is no longer required.
	 */
	dispose() {

		super.dispose();

		if ( this._sampleRenderTarget !== null ) {

			this._sampleRenderTarget.dispose();
			this._historyRenderTarget.dispose();

		}

		this._resolveMaterial.dispose();

	}

}

export default TRAAPassNode;

// These jitter vectors are specified in integers because it is easier.
// I am assuming a [-8,8) integer grid, but it needs to be mapped onto [-0.5,0.5)
// before being used, thus these integers need to be scaled by 1/16.
//
// Sample patterns reference: https://msdn.microsoft.com/en-us/library/windows/desktop/ff476218%28v=vs.85%29.aspx?f=255&MSPPError=-2147217396
const _JitterVectors = [
	[ - 4, - 7 ], [ - 7, - 5 ], [ - 3, - 5 ], [ - 5, - 4 ],
	[ - 1, - 4 ], [ - 2, - 2 ], [ - 6, - 1 ], [ - 4, 0 ],
	[ - 7, 1 ], [ - 1, 2 ], [ - 6, 3 ], [ - 3, 3 ],
	[ - 7, 6 ], [ - 3, 6 ], [ - 5, 7 ], [ - 1, 7 ],
	[ 5, - 7 ], [ 1, - 6 ], [ 6, - 5 ], [ 4, - 4 ],
	[ 2, - 3 ], [ 7, - 2 ], [ 1, - 1 ], [ 4, - 1 ],
	[ 2, 1 ], [ 6, 2 ], [ 0, 4 ], [ 4, 4 ],
	[ 2, 5 ], [ 7, 5 ], [ 5, 6 ], [ 3, 7 ]
];

/**
 * TSL function for creating a TRAA pass node for Temporal Reprojection Anti-Aliasing.
 *
 * @tsl
 * @function
 * @param {Scene} scene - The scene to render.
 * @param {Camera} camera - The camera to render the scene with.
 * @returns {TRAAPassNode}
 */
export const traaPass = ( scene, camera ) => nodeObject( new TRAAPassNode( scene, camera ) );
