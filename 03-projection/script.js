// System that keeps track of the spotlights in the scene.
AFRAME.registerSystem('spotlights', {
	spotLights: [],
	tick: function(t, dt) {
		this.spotLights = [];

		// Collect the spotLights in the scene.
		// The resulting order needs to match with ThreeJS's order,
		// otherwise the extra spotlight uniforms end up on the wrong spotlight.
		const camera = this.el.sceneEl.camera;
		this.el.sceneEl.object3D.traverseVisible((object) => {
			if(object.isLight && object.isSpotLight && object.layers.test(camera.layers)) {
				this.spotLights.push(object);
			}
		});

		// Sort the shadow casting spotlights to the front
		this.spotLights.sort((lightA, lightB) => ( lightB.castShadow ? 1 : 0 ) - ( lightA.castShadow ? 1 : 0 ));
	},
});

// Component to assign a texture and intensity to a spotlight
AFRAME.registerComponent('spotlight-texture', {
    schema: {
        src: { type: 'map' },
		intensity: { type: 'number', default: 10.0 },
    },
    update: function(oldData) {
		if(this.data.src !== oldData.src) {
			this.updateSrc();
		}
	},
	updateSrc: function() {
		const src = this.data.src;
		this.texture = undefined;
		this.el.sceneEl.systems.material.loadTexture(src, {src: src}, (texture) => {
			// Assume the texture used for the spotlight texture isn't linear
			this.el.sceneEl.systems.renderer.applyColorCorrection(texture);
			this.texture = texture;
		});
	},
});

// Component for entities that should be lit by the spotlight
AFRAME.registerComponent('receive-spotlight-texture', {
    init: function() {
		// Method for updating the (extra) uniforms
		const updateUniforms = (shaderObject, camera) => {
			const extras = [];
			const textures = [];

			this.el.sceneEl.systems['spotlights'].spotLights.forEach(spotLight => {
				const spotLightTextureInfo = spotLight.el.components['spotlight-texture'];

				// Start with an up vector (model space)
				const up = new THREE.Vector3(0.0, 1.0, 0.0);
				// Transform it based on the spotLight's transform (world space)
				up.transformDirection(spotLight.matrixWorld);
				// Transform it based on the camera (camera space)
				up.transformDirection(camera.matrixWorldInverse);

				extras.push({
					up,
					hasTexture: !!spotLightTextureInfo?.texture,
					intensity: spotLightTextureInfo?.data.intensity,
				});

				textures.push(spotLightTextureInfo?.texture);
			});

			// Note: setting the uniforms this way isn't optimal, but works for this demo
			shaderObject.uniforms.spotLightExs = { value: extras };
			shaderObject.uniforms.spotLightTextures = { value: textures };
		}

		// Hook into the material to update the uniforms
		const material = this.el.getObject3D('mesh').material;

		let shaderObject = null;
		material.onBeforeCompile = (shader) => {
			updateUniforms(shader, this.el.sceneEl.camera);
			shaderObject = shader;
		};

		material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
			if(!shaderObject) { return; }
			updateUniforms(shaderObject, camera);
		}
    }
});

// Simple component for rotating the spotlight around
AFRAME.registerComponent('rotate-round', {
	tick: function (t, dt) {
		this.el.object3D.rotation.y = t / 2000;
	}
});

/////////////////////////////////////
// THREE.JS SHADER PATCHING BELOW  //
/////////////////////////////////////

// Patch lights_pars_begin
const lights_pars_begin_lines = THREE.ShaderChunk.lights_pars_begin.split('\n');
const spot_light_start_line = lights_pars_begin_lines.indexOf('#if NUM_SPOT_LIGHTS > 0');
const spot_light_end_line = lights_pars_begin_lines.indexOf('#endif', spot_light_start_line);
lights_pars_begin_lines.splice(spot_light_start_line, spot_light_end_line - spot_light_start_line + 1, `
#if NUM_SPOT_LIGHTS > 0

	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};

	struct SpotLightEx {
		vec3 up;
		bool hasTexture;
		float intensity;
	};

	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
    uniform sampler2D spotLightTextures[ NUM_SPOT_LIGHTS ];
	uniform SpotLightEx spotLightExs[ NUM_SPOT_LIGHTS ];

	// light is an out parameter as having it as a return value caused compiler errors on some devices
	void getSpotLightInfo( const in SpotLight spotLight, const in SpotLightEx spotLightEx, const in sampler2D spotLightTexture, const in GeometricContext geometry, out IncidentLight light) {

		vec3 lVector = spotLight.position - geometry.position;

		light.direction = normalize( lVector );

		float angleCos = dot( light.direction, spotLight.direction );

		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );

		if ( spotAttenuation > 0.0 || spotAttenuation <= 0.0) {

			float lightDistance = length( lVector );

			vec3 color = spotLight.color;
			if(spotLightEx.hasTexture) {
				vec3 left = normalize(cross(spotLightEx.up, spotLight.direction));
				vec2 samplePoint = vec2(0.5);

				float coneAngle = acos(spotLight.coneCos);
				float leftCos = dot(light.direction, left);
				float leftAngle = acos(leftCos);

				float upCos = dot(light.direction, spotLightEx.up);
				float upAngle = acos(upCos);

				samplePoint += (vec2(leftAngle, upAngle) - PI/2.0) / (2.0*coneAngle);

				color = texture(spotLightTexture, samplePoint).rgb * spotLightEx.intensity;
			}

			light.color = color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );

		} else {

			light.color = vec3( 0.0 );
			light.visible = false;

		}

	}
#endif
`)
THREE.ShaderChunk.lights_pars_begin = lights_pars_begin_lines.join('\n');

// Patch lights_fragment_begin
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.split('\n')
	.map(l =>
		l === '		getSpotLightInfo( spotLight, geometry, directLight );' ?
			  '		getSpotLightInfo( spotLight, spotLightExs[UNROLLED_LOOP_INDEX], spotLightTextures[UNROLLED_LOOP_INDEX], geometry, directLight );' : l)
	.join('\n');

// Patch light_lambert_vertex
THREE.ShaderChunk.lights_lambert_vertex = THREE.ShaderChunk.lights_lambert_vertex.split('\n')
	.map(l =>
		l === '		getSpotLightInfo( spotLights[ i ], geometry, directLight );' ?
		      '': l)
	.join('\n');